/**
 * dsh-progress-osd — 监听 DSH 会话进度，用 DeepSeek 概括成一句中文，推到桌面。
 *
 * 两条出口：
 *   1. 顶栏 OSD：按 `~/customshell-arch-config/dsh/OSD-PROTOCOL.md` 写
 *      `~/.cache/dsh-osd.json`（customshell 的 DshOsdState.qml 每 500ms 读一次）。
 *   2. 桌面通知：`notify-send`（niri + mako）。
 *
 * 事件来源（cordis，scoped 事件需要 { global: true }）：
 *   session/event  (session, event)  event.type: turn/start | step/start | step/end
 *                                    | tool/call | tool/result | todo/write
 *                                    | assistant/message | turn/end
 *   agent/status   { agent, status: 'idle' | 'running' }
 *
 * 成本控制：
 *   - 两次概括之间至少 debounceMs（默认 5s）的静默期，期间事件只更新快照；
 *   - turn/end 强制立即概括一次；
 *   - System Prompt 是常量、内容里没有任何变量，配合 DeepSeek 的自动前缀缓存；
 *   - max_tokens 100，temperature 0，AbortController 硬超时；
 *   - 没有 DEEPSEEK_API_KEY / 请求失败 / 超时 → 本地规则兜底文本，照样推送。
 *
 * 环境变量（都可选）：
 *   DEEPSEEK_API_KEY       DeepSeek 密钥（唯一必需项，没有则只用兜底文本）
 *   DEEPSEEK_BASE_URL     默认 https://api.deepseek.com
 *   DSH_OSD_MODEL         默认 deepseek-chat
 *   DSH_OSD_DEBOUNCE_MS   默认 5000
 *   DSH_OSD_NOTIFY        默认 1；0 关闭桌面通知
 *   DSH_OSD_NOTIFY_LIVE   默认 0；1 表示运行中也弹通知（受 minNotifyGapMs 限制）
 *   DSH_OSD_KEY           OSD 里用的任务 id，默认 `dsh-<pid>`
 *   DSH_OSD_FILE          默认 ~/.cache/dsh-osd.json
 *   DSH_OSD_POLL_URL      可选。事件流拿不到进度时轮询的 URL，默认
 *                           http://127.0.0.1:3080/agent-status/api/state（探测不通自动停）
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const name = "dsh-progress-osd";
export const inject: string[] = [];

/* ------------------------------------------------------------------ *
 * 固定 System Prompt（不要加变量，否则打断 DeepSeek 前缀缓存）
 * ------------------------------------------------------------------ */
const SYSTEM_PROMPT = [
  "你是 DSH 的进度播报器。你会收到一个 JSON 快照，描述某个编码任务此刻或刚结束时的状态。",
  "要求：",
  "1. 用简体中文写一句话，总长不超过 30 个字符，概括当前进度。",
  '2. stage 为 "running"：说明此刻正在做什么，例如「正在改 niri 快捷键」。',
  '3. stage 为 "done"：说明这一轮做成了什么，例如「已完成配置修改并重启服务」。',
  '4. todo 数组非空时，可在句末补完成度，例如「待办 2/5」；不必每次补。',
  "5. 只输出这句话本身：不要引号、不要解释、不要寒暄、不要换行、不要 emoji。",
].join("\n");

const APP_NAME = "DSH 进度";
const ICON = "utilities-terminal";

/* ------------------------------------------------------------------ *
 * 类型（自包含，不 import DSH 内部类型包：link 进 profile 后解析不到）
 * ------------------------------------------------------------------ */
type Timer = ReturnType<typeof setTimeout>;

interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

interface SessionEventLike {
  type: string;
  seq?: number;
  time?: number;
  data?: Record<string, unknown>;
}

interface SessionLike {
  id?: unknown;
}

interface LoggerLike {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

interface ContextLike {
  logger?: LoggerLike;
  on?: (event: string, handler: (...args: never[]) => void, options?: { global?: boolean }) => unknown;
  effect?: (fn: () => (() => void) | void, label?: string) => unknown;
}

export interface Config {
  model?: string;
  baseUrl?: string;
  apiTimeoutMs?: number;
  debounceMs?: number;
  maxChars?: number;
  notify?: boolean;
  notifyLive?: boolean;
  minNotifyGapMs?: number;
  /** 一轮结束时播放提示音（默认 true） */
  sound?: boolean;
  /** 提示音文件，默认 freedesktop 的 complete.oga；设为空串则改用 canberra 音效名 */
  soundFile?: string;
  doneHoldMs?: number;
  pollUrl?: string;
  pollIntervalMs?: number;
  /** DSH 凭据文件路径，默认 $DSH_HOME/.credentials.yaml（即 ~/.dsh/.credentials.yaml） */
  credentialsFile?: string;
}

interface ResolvedConfig {
  model: string;
  baseUrl: string;
  apiTimeoutMs: number;
  debounceMs: number;
  maxChars: number;
  notify: boolean;
  notifyLive: boolean;
  minNotifyGapMs: number;
  sound: boolean;
  soundFile: string;
  doneHoldMs: number;
  pollUrl: string;
  pollIntervalMs: number;
  osdFile: string;
  osdKey: string;
  credentialsFile: string;
}

interface Snapshot {
  sessionId: string;
  turn: number;
  step: number;
  action: string;
  detail: string;
  phase: string;
  todos: TodoItem[];
  lastText: string;
  summary: string;
  startedAt: number;
  updatedAt: number;
  done: boolean;
  endReason: string;
  /** 收尾态（OSD done + 提示音）是否已经推过，避免网络回来后再推一次 */
  doneNotified: boolean;
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */
const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
};

const envFlag = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === "") return fallback;
  return !/^(0|false|no|off)$/i.test(value.trim());
};

/** 控制字符 / 换行 → 空格，压平空白。终端与通知都只接受单行。 */
function flatten(value: unknown, limit: number): string {
  const text = String(value ?? "")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  return text.slice(0, Math.max(1, limit - 1)) + "…";
}

/** 按「字符」截断（Array.from 才不会把 emoji / 生僻字切成半个）。 */
function truncateChars(value: string, limit: number): string {
  const chars = Array.from(value);
  if (chars.length <= limit) return value;
  return chars.slice(0, Math.max(1, limit - 1)).join("") + "…";
}

function resolveConfig(config: Config | undefined, logger?: LoggerLike): ResolvedConfig {
  const cfg = config ?? {};
  const env = process.env;
  const debounceRaw = env.DSH_OSD_DEBOUNCE_MS ?? cfg.debounceMs;
  return {
    model: env.DSH_OSD_MODEL ?? cfg.model ?? "deepseek-chat",
    baseUrl: (env.DEEPSEEK_BASE_URL ?? cfg.baseUrl ?? "https://api.deepseek.com").replace(/\/+$/, ""),
    apiTimeoutMs: clampInt(cfg.apiTimeoutMs, 8000, 1000, 30000),
    // 硬性下限 5000：需求要求「至少 5 秒防抖」，配置调小也压回 5s，避免把 API 打爆
    debounceMs: clampInt(debounceRaw, 5000, 5000, 120000),
    maxChars: clampInt(cfg.maxChars, 30, 10, 80),
    // 默认不弹系统 toast：进度只在顶栏 OSD 展示，收尾用提示音提醒
    notify: envFlag(env.DSH_OSD_NOTIFY, cfg.notify ?? false),
    notifyLive: envFlag(env.DSH_OSD_NOTIFY_LIVE, cfg.notifyLive ?? false),
    minNotifyGapMs: clampInt(cfg.minNotifyGapMs, 5000, 1000, 600000),
    sound: envFlag(env.DSH_OSD_SOUND, cfg.sound ?? true),
    soundFile:
      env.DSH_OSD_SOUND_FILE ??
      cfg.soundFile ??
      "/usr/share/sounds/freedesktop/stereo/complete.oga",
    doneHoldMs: clampInt(cfg.doneHoldMs, 3000, 500, 30000),
    pollUrl:
      env.DSH_OSD_POLL_URL ??
      cfg.pollUrl ??
      "http://127.0.0.1:3080/agent-status/api/state",
    pollIntervalMs: clampInt(cfg.pollIntervalMs, 5000, 1000, 60000),
    osdFile: env.DSH_OSD_FILE ?? path.join(os.homedir(), ".cache", "dsh-osd.json"),
    osdKey: env.DSH_OSD_KEY ?? `dsh-${process.pid}`,
    // DSH 自己的凭据库：DEEPSEEK_API_KEY 就存在这里的 refs 段
    credentialsFile:
      env.DSH_OSD_CREDENTIALS ??
      cfg.credentialsFile ??
      path.join(env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), ".credentials.yaml"),
  };
}

/* ------------------------------------------------------------------ *
 * 顶栏 OSD（协议：OSD-PROTOCOL.md）
 * ------------------------------------------------------------------ */
interface OsdEntry {
  label: string;
  command: string;
  done: boolean;
  since: number;
  updated: number;
}

function readOsdState(file: string): Record<string, OsdEntry> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, OsdEntry>;
    }
    return {};
  } catch {
    // 文件不存在 / 正被别的进程写坏：当成空，稍后覆盖成完整 JSON。
    return {};
  }
}

/** 原子写：先写临时文件再 rename，避免 QML 侧 cat 到半截 JSON。 */
function writeOsdState(file: string, state: Record<string, OsdEntry>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM";
  }
}

/** 清掉异常退出（kill -9 / 崩溃）留下的 dsh-<pid> 键，否则顶栏一直被占。 */
function pruneStaleEntries(file: string, logger?: LoggerLike): void {
  try {
    const state = readOsdState(file);
    let changed = false;
    for (const key of Object.keys(state)) {
      if (!key.startsWith("dsh-")) continue;
      const pid = Number(key.slice(4));
      if (Number.isInteger(pid) && pid > 0 && pidAlive(pid)) continue;
      delete state[key];
      changed = true;
    }
    if (changed) writeOsdState(file, state);
  } catch (error) {
    logger?.warn?.(`dsh-progress-osd: 清理 OSD 残留失败: ${(error as Error)?.message ?? String(error)}`);
  }
}

/* ------------------------------------------------------------------ *
 * 动作词（label 列只有 64px，最多 3~4 个中文字）
 * ------------------------------------------------------------------ */
const ACTION_LABELS: Record<string, string> = {
  bash: "运行命令",
  read: "读文件",
  write: "写文件",
  edit: "改文件",
  grep: "搜索",
  glob: "找文件",
  web_search: "联网",
  web_fetch: "开网页",
  subagent: "子任务",
  subagent_fork: "子任务",
  todo_write: "理任务",
  present: "出结果",
  ask_user_question: "等回答",
  skill: "载技能",
  compress: "压缩",
  decompress: "展开",
  acp_status: "看上下文",
};

function actionLabel(tool: string): string {
  if (!tool) return "处理中";
  const mapped = ACTION_LABELS[tool];
  if (mapped) return mapped;
  return flatten(tool, 4) || "处理中";
}

/** tool/call.arguments 是模型原样输出的 JSON 字符串，不是对象。 */
function shortDetail(tool: string, rawArguments: unknown): string {
  let args: Record<string, unknown> = {};
  if (typeof rawArguments === "string") {
    try {
      const parsed = JSON.parse(rawArguments);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      args = {};
    }
  } else if (rawArguments && typeof rawArguments === "object") {
    args = rawArguments as Record<string, unknown>;
  }

  if (typeof args.description === "string" && args.description.trim()) {
    return flatten(args.description, 120);
  }
  if (tool === "bash" && typeof args.command === "string") {
    return flatten(args.command.split(/\r?\n/)[0] ?? "", 120);
  }
  if (typeof args.file_path === "string") return flatten(args.file_path, 120);
  if (typeof args.pattern === "string") return flatten(args.pattern, 120);
  if (typeof args.query === "string") return flatten(args.query, 120);
  if (typeof args.url === "string") return flatten(args.url, 120);
  return "";
}

/* ------------------------------------------------------------------ *
 * DeepSeek 调用
 * ------------------------------------------------------------------ */
function sanitizeModelText(raw: string): string {
  let text = raw
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^[\s"'“”‘’「」]+|[\s"'“”‘’「」]+$/g, "")
    .replace(/^(概括|摘要|进度)\s*[:：]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
  // 模型偶尔会输出多句，只留第一句
  const cut = text.search(/[。！？!?]\s/);
  if (cut > 0) text = text.slice(0, cut);
  return text.trim();
}

interface DeepSeekResult {
  text: string | null;
  error?: string;
}

/**
 * 找 API key 的优先链：进程环境变量 → DSH 自己的凭据库（~/.dsh/.credentials.yaml）。
 *
 * DSH 把在设置面板里填的 key 存在凭据文件里（refs.DEEPSEEK_API_KEY），并不会导出到
 * 子进程环境，所以插件光读 process.env 是拿不到的。这里直接复用同一个 key：
 * 用户在 DSH 里配一次，插件就能跟着用，不需要再单独配一份。
 *
 * 只做「refs 段里找同名键」的行级解析，不引入 YAML 依赖；解析失败静默返回空串。
 */
let keyCache: { value: string; at: number } | null = null;

function keyFromCredentialsFile(file: string): string {
  try {
    const text = fs.readFileSync(file, "utf8");
    let inRefs = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^refs:\s*$/.test(line)) {
        inRefs = true;
        continue;
      }
      if (inRefs) {
        if (/^\S/.test(line)) inRefs = false; // 顶格的新键 = refs 段结束
        else {
          const match = /^\s+([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/.exec(line);
          if (match && match[1] === "DEEPSEEK_API_KEY") {
            return match[2].replace(/^["']|["']$/g, "").trim();
          }
        }
      }
      // 兼容 refs 写成单行内联对象的情况
      const inline = /^\{?\s*DEEPSEEK_API_KEY\s*:\s*([^,}\s]+)/.exec(line);
      if (!inRefs && inline) return inline[1].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* 文件不存在 / 没权限：静默降级 */
  }
  return "";
}

function resolveApiKey(cfg: ResolvedConfig, logger?: LoggerLike): string {
  const fromEnv = (process.env.DEEPSEEK_API_KEY ?? "").trim();
  if (fromEnv) return fromEnv;

  if (keyCache && Date.now() - keyCache.at < 60_000) return keyCache.value;

  const fromFile = keyFromCredentialsFile(cfg.credentialsFile);
  keyCache = { value: fromFile, at: Date.now() };
  if (fromFile) {
    logger?.info?.(`dsh-progress-osd: 复用 DSH 凭据库里的 DEEPSEEK_API_KEY（${cfg.credentialsFile}）`);
  }
  return fromFile;
}

async function callDeepSeek(
  cfg: ResolvedConfig,
  userContent: string,
  logger?: LoggerLike,
): Promise<DeepSeekResult> {
  const apiKey = resolveApiKey(cfg, logger);
  if (!apiKey) {
    return {
      text: null,
      error: `DEEPSEEK_API_KEY 未设置（环境变量与 ${cfg.credentialsFile} 都没有）`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.apiTimeoutMs);
  timer.unref?.();

  try {
    const response = await (globalThis as { fetch: typeof fetch }).fetch(
      `${cfg.baseUrl}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          max_tokens: 100,
          temperature: 0,
          stream: false,
        }),
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { text: null, error: `HTTP ${response.status} ${flatten(body, 120)}` };
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return { text: null, error: "响应里没有 choices[0].message.content" };

    const text = sanitizeModelText(content);
    if (!text) return { text: null, error: "模型返回空文本" };
    return { text: truncateChars(text, cfg.maxChars) };
  } catch (error) {
    const err = error as { name?: string; message?: string };
    const reason = err?.name === "AbortError" ? `请求超时（${cfg.apiTimeoutMs}ms）` : (err?.message ?? String(error));
    return { text: null, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * 本地兜底摘要（API 不可用时也要有话说）
 * ------------------------------------------------------------------ */
function todoProgress(snapshot: Snapshot): string {
  if (snapshot.todos.length === 0) return "";
  const done = snapshot.todos.filter((item) => item.status === "completed").length;
  return `待办 ${done}/${snapshot.todos.length}`;
}

function fallbackSummary(snapshot: Snapshot, stage: "running" | "done", maxChars: number): string {
  const progress = todoProgress(snapshot);
  if (stage === "done") {
    if (snapshot.endReason === "aborted") return truncateChars(["已中止本轮", progress].filter(Boolean).join(" · "), maxChars);
    if (snapshot.endReason === "error") return truncateChars(["本轮出错", progress].filter(Boolean).join(" · "), maxChars);
    const action = snapshot.action ? `已完成${actionLabel(snapshot.action)}` : "任务已完成";
    return truncateChars([action, progress].filter(Boolean).join(" · "), maxChars);
  }
  const parts = [snapshot.phase, snapshot.detail ? truncateChars(snapshot.detail, 18) : "", progress];
  return truncateChars(parts.filter(Boolean).join(" · ") || "正在处理", maxChars);
}

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */
export function apply(ctx: ContextLike, config?: Config): void {
  const logger = ctx.logger;
  const cfg = resolveConfig(config, logger);
  const startedAt = Date.now();

  /* ---------------- 快照与状态 ---------------- */
  const sessions = new Map<string, Snapshot>();
  let activeSessionId = "";
  let lastSummary = "";

  let debounceTimer: Timer | null = null;
  let osdTimer: Timer | null = null;
  let doneTimer: Timer | null = null;
  let lastOsdWrite = 0;
  let lastOsdLabel = "";
  let lastOsdCommand = "";
  let lastOsdDone = false;
  let osdShown = false;
  let since = 0;

  let lastNotifyAt = 0;
  let lastNotifyText = "";

  let summarizeInFlight = false;
  let pendingStage: "running" | "done" | null = null;

  let eventSeen = false;
  let pollTimer: Timer | null = null;
  let pollFailures = 0;
  let pollDisabled = cfg.pollUrl === "";
  let warnedNoKey = false;
  let warnedApiOnce = false;

  const sessionIdOf = (session: SessionLike | undefined): string => {
    const id = session?.id;
    if (id === undefined || id === null) return "default";
    return typeof id === "string" ? id : String(id);
  };

  function newSnapshot(sessionId: string, turn: number): Snapshot {
    const now = Date.now();
    return {
      sessionId,
      turn,
      step: 0,
      action: "",
      detail: "",
      phase: "思考中",
      todos: [],
      lastText: "",
      summary: lastSummary,
      startedAt: now,
      updatedAt: now,
      done: false,
      endReason: "",
      doneNotified: false,
    };
  }

  function snapshotFor(sessionId: string): Snapshot {
    let snapshot = sessions.get(sessionId);
    if (!snapshot) {
      snapshot = newSnapshot(sessionId, 0);
      sessions.set(sessionId, snapshot);
      // 多开会话时不让 Map 无限长
      if (sessions.size > 8) {
        const oldest = [...sessions.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
        if (oldest && oldest[0] !== sessionId) sessions.delete(oldest[0]);
      }
    }
    return snapshot;
  }

  function activeSnapshot(): Snapshot | null {
    if (activeSessionId) {
      const found = sessions.get(activeSessionId);
      if (found) return found;
    }
    if (sessions.size === 0) return null;
    return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
  }

  /* ---------------- OSD 写入 ---------------- */
  function pushOsd(state: { label: string; command: string; done: boolean }, restart: boolean): void {
    const now = Date.now();
    if (restart || !since) since = now;

    const write = (): void => {
      osdTimer = null;
      lastOsdWrite = Date.now();
      lastOsdLabel = state.label;
      lastOsdCommand = state.command;
      lastOsdDone = state.done;
      try {
        const table = readOsdState(cfg.osdFile);
        table[cfg.osdKey] = {
          label: state.label,
          command: state.command,
          done: state.done,
          since,
          updated: Date.now(),
        };
        writeOsdState(cfg.osdFile, table);
        osdShown = true;
      } catch (error) {
        logger?.warn?.(`dsh-progress-osd: 写 OSD 失败: ${(error as Error)?.message ?? String(error)}`);
      }
    };

    if (state.done) {
      if (osdTimer) {
        clearTimeout(osdTimer);
        osdTimer = null;
      }
      write();
      return;
    }

    // 协议要求 300ms 节流；内容没变就不重复写盘（updated 只在真变化时刷新）。
    if (state.label === lastOsdLabel && state.command === lastOsdCommand && !lastOsdDone && osdShown) return;
    if (osdTimer) return;
    const wait = Math.max(0, 300 - (now - lastOsdWrite));
    osdTimer = setTimeout(write, wait);
    osdTimer.unref?.();
  }

  function clearOsd(): void {
    if (osdTimer) {
      clearTimeout(osdTimer);
      osdTimer = null;
    }
    if (!osdShown) return;
    osdShown = false;
    since = 0;
    try {
      const table = readOsdState(cfg.osdFile);
      if (!(cfg.osdKey in table)) return;
      delete table[cfg.osdKey];
      writeOsdState(cfg.osdFile, table);
    } catch (error) {
      logger?.warn?.(`dsh-progress-osd: 清除 OSD 失败: ${(error as Error)?.message ?? String(error)}`);
    }
  }

  /* ---------------- 桌面通知 ---------------- */
  function notifySend(title: string, body: string): void {
    if (!cfg.notify) return;
    const safeTitle = flatten(title, 64) || APP_NAME;
    const safeBody = flatten(body, 160);
    if (!safeBody) return;
    // execFile 直接传参数数组，不经过 shell，天然免疫命令注入；
    // 仍要压平控制字符，避免 mako 渲染异常。`--` 终止选项解析，防正文/标题以 "-" 开头被当参数。
    execFile(
      "notify-send",
      ["-a", APP_NAME, "-i", ICON, "-t", "6000", "--", safeTitle, safeBody],
      { timeout: 3000 },
      (error) => {
        if (error) logger?.warn?.(`dsh-progress-osd: notify-send 失败: ${error.message}`);
      },
    );
  }

  function notifyThrottled(text: string): void {
    if (!text) return;
    const now = Date.now();
    if (text === lastNotifyText && now - lastNotifyAt < 60000) return;
    if (now - lastNotifyAt < cfg.minNotifyGapMs) return;
    lastNotifyAt = now;
    lastNotifyText = text;
    notifySend(APP_NAME, text);
  }

  /* ---------------- 提示音 ---------------- */
  function playDoneSound(): void {
    if (!cfg.sound) return;
    // 只用 execFile 传参数数组：不经过 shell，文件名里的空格/引号都不会变成命令
    const file = cfg.soundFile;
    const fallback = (): void => {
      execFile("canberra-gtk-play", ["-i", "complete"], { timeout: 2000 }, () => {});
    };
    try {
      if (file && fs.existsSync(file)) {
        execFile("paplay", [file], { timeout: 2000 }, (error) => {
          if (error) fallback();
        });
        return;
      }
    } catch {
      // 文件探测失败直接走 canberra
    }
    fallback();
  }

  /* ---------------- 即时本地文本（不等模型） ---------------- */
  /**
   * 事件到达的瞬间就先给顶栏一句话：只有本地拼装，零网络。
   * 5 秒后模型概括回来再覆盖它，所以进度永远「先到一步」。
   */
  function liveText(snapshot: Snapshot): string {
    const progress = todoProgress(snapshot);
    const parts: string[] = [];
    if (snapshot.action) {
      const label = actionLabel(snapshot.action);
      parts.push(snapshot.detail ? `${label} · ${truncateChars(snapshot.detail, 28)}` : label);
    } else if (snapshot.lastText) {
      parts.push(truncateChars(flatten(snapshot.lastText, 24), 24));
    } else {
      parts.push("处理中");
    }
    if (progress) parts.push(progress);
    return truncateChars(parts.join(" · "), 44);
  }

  function buildSnapshotJson(snapshot: Snapshot, stage: "running" | "done"): string {
    const payload: Record<string, unknown> = {
      stage,
      turn: snapshot.turn,
      step: snapshot.step,
      state: snapshot.phase,
      tool: snapshot.action || undefined,
      doing: snapshot.detail ? truncateChars(snapshot.detail, 120) : undefined,
      todos: snapshot.todos.length
        ? snapshot.todos.slice(0, 8).map((item) => ({
            text: truncateChars(flatten(item.content, 60), 60),
            status: item.status,
          }))
        : undefined,
      lastReply: snapshot.lastText ? truncateChars(snapshot.lastText, 200) : undefined,
      endReason: stage === "done" ? snapshot.endReason || "completed" : undefined,
      elapsedSec: Math.max(0, Math.round((Date.now() - snapshot.startedAt) / 1000)),
    };
    return JSON.stringify(payload);
  }

  function publishRunning(snapshot: Snapshot, text: string): void {
    snapshot.summary = text;
    lastSummary = text;
    // label 固定两态，动作细节在 command 里，避免「思考中/执行中」来回跳
    pushOsd({ label: "执行中", command: text, done: false }, false);
  }

  function publishDone(snapshot: Snapshot, text: string): void {
    snapshot.summary = text;
    // 不写 lastSummary：否则下一轮 turn/start 会把「已完成」这类收尾语当作 command 顶上去
    if (snapshot.doneNotified) {
      // 已经收尾过了（本地先推、模型后到）：OSD 保持不变，只记录更凝练的一版
      logger?.info?.(`dsh-progress-osd: 本轮概括 ${text}`);
      return;
    }
    snapshot.doneNotified = true;
    pushOsd({ label: "任务已完成", command: "", done: true }, false);
    notifySend(APP_NAME, text);
    playDoneSound();
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = setTimeout(() => {
      doneTimer = null;
      clearOsd();
    }, cfg.doneHoldMs);
    doneTimer.unref?.();
  }

  async function summarize(stage: "running" | "done", options?: { force?: boolean }): Promise<void> {
    const snapshot = activeSnapshot();
    if (!snapshot) return;
    if (snapshot.done && stage === "running") return;

    // 运行中不强制：刚概括过（<2s）且文本已存在就跳过，省 token
    if (stage === "running" && !options?.force && snapshot.summary && Date.now() - snapshot.updatedAt < 1500) return;

    if (summarizeInFlight) {
      // 保留最强的 stage：进行中的请求结束后，done 优先补发，绝不降级成 running
      if (stage === "done" || pendingStage === null) pendingStage = stage;
      return;
    }
    summarizeInFlight = true;
    try {
      const userContent = buildSnapshotJson(snapshot, stage);
      let text: string | null = null;
      try {
        const result = await callDeepSeek(cfg, userContent, logger);
        text = result.text;
        if (!text && result.error) {
          if (result.error.includes("DEEPSEEK_API_KEY")) {
            if (!warnedNoKey) {
              warnedNoKey = true;
              logger?.info?.("dsh-progress-osd: 未设置 DEEPSEEK_API_KEY，改用本地兜底摘要（通知与 OSD 照常工作）");
            }
          } else if (!warnedApiOnce) {
            warnedApiOnce = true;
            logger?.warn?.(`dsh-progress-osd: 概括失败，改用兜底文本: ${result.error}`);
          } else {
            logger?.info?.(`dsh-progress-osd: 概括失败（已降级）: ${result.error}`);
          }
        }
      } catch (error) {
        logger?.warn?.(`dsh-progress-osd: 概括异常: ${(error as Error)?.message ?? String(error)}`);
      }

      const finalText = text ?? fallbackSummary(snapshot, stage, cfg.maxChars);

      if (stage === "done") {
        publishDone(snapshot, finalText);
      } else {
        publishRunning(snapshot, finalText);
        if (cfg.notifyLive) notifyThrottled(finalText);
      }
    } finally {
      summarizeInFlight = false;
      const next = pendingStage;
      pendingStage = null;
      if (next === "done") {
        void summarize("done", { force: true });
      } else if (next === "running") {
        const latest = activeSnapshot();
        if (latest && !latest.done) void summarize("running", { force: true });
      }
    }
  }

  function scheduleSummarize(): void {
    // 关键：不重置计时器。否则连续动作（每几秒一个 tool）会把 5 秒一推再推，
    // 概括永远等不到窗口，表现就是「活都干完了才冒出一句话」。
    if (debounceTimer) return;
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void summarize("running");
    }, cfg.debounceMs);
    debounceTimer.unref?.();
  }

  /* ---------------- 事件 ---------------- */
  function onSessionEvent(session: SessionLike, event: SessionEventLike): void {
    try {
      const type = event?.type;
      if (!type) return;
      eventSeen = true;
      const sessionId = sessionIdOf(session);
      activeSessionId = sessionId;
      const data = (event.data ?? {}) as Record<string, unknown>;
      const snapshot = snapshotFor(sessionId);
      snapshot.updatedAt = Date.now();

      if (type === "turn/start") {
        const turn = Number(data.turn ?? 0);
        sessions.set(sessionId, newSnapshot(sessionId, turn));
        if (doneTimer) {
          clearTimeout(doneTimer);
          doneTimer = null;
        }
        // 新一轮从干净状态起步，不要拿上一轮的摘要顶上（那正是「看着像没动」的来源）
        pushOsd({ label: "思考中", command: "", done: false }, true);
        return;
      }

      if (type === "step/start") {
        snapshot.step = Number(data.step ?? snapshot.step);
        snapshot.phase = "思考中";
        pushOsd({ label: "思考中", command: liveText(snapshot), done: false }, false);
        return;
      }

      if (type === "step/end") {
        snapshot.step = Number(data.step ?? snapshot.step);
        return;
      }

      if (type === "tool/call") {
        snapshot.action = typeof data.name === "string" ? data.name : "";
        snapshot.detail = shortDetail(snapshot.action, data.arguments);
        snapshot.phase = actionLabel(snapshot.action);
        // label 只表达「在思考 / 在执行」，具体动作交给 command（那里有空格跑马灯）
        pushOsd({ label: "执行中", command: liveText(snapshot), done: false }, false);
        scheduleSummarize();
        return;
      }

      if (type === "tool/result") {
        // 工具刚跑完、模型还在看结果：整段都算执行阶段，别急着切回「思考中」
        snapshot.phase = "执行中";
        pushOsd({ label: "执行中", command: liveText(snapshot), done: false }, false);
        scheduleSummarize();
        return;
      }

      if (type === "todo/write") {
        const todos = Array.isArray(data.todos) ? (data.todos as TodoItem[]) : [];
        snapshot.todos = todos.filter(
          (item) => item && typeof item.content === "string" && typeof item.status === "string",
        );
        pushOsd({ label: "执行中", command: liveText(snapshot), done: false }, false);
        scheduleSummarize();
        return;
      }

      if (type === "assistant/message") {
        const message = data.message as { content?: unknown } | undefined;
        const content = message?.content;
        if (typeof content === "string") snapshot.lastText = flatten(content, 400);
        else if (Array.isArray(content)) {
          const joined = content
            .map((part) =>
              part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
                ? (part as { text: string }).text
                : "",
            )
            .join(" ");
          snapshot.lastText = flatten(joined, 400);
        }
        // 模型一旦开始产出内容，就是「事情在推进」，按执行态展示；真正没开口才是思考中
        if (!snapshot.done) pushOsd({ label: "执行中", command: liveText(snapshot), done: false }, false);
        return;
      }

      if (type === "turn/end") {
        const reason = data.reason as { kind?: string } | undefined;
        snapshot.endReason = typeof reason?.kind === "string" ? reason.kind : "completed";
        snapshot.done = true;
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        // 关键：本地兜底文本 + 提示音立刻落地（不等网络），模型概括随后补发
        publishDone(snapshot, fallbackSummary(snapshot, "done", cfg.maxChars));
        void summarize("done", { force: true });
        return;
      }
    } catch (error) {
      logger?.warn?.(`dsh-progress-osd: session/event 处理失败: ${(error as Error)?.message ?? String(error)}`);
    }
  }

  function onAgentStatus(payload: { status?: string } | undefined): void {
    try {
      if (payload?.status !== "idle") return;
      // 兜底：turn/end 没等到（异常退出/取消），idle 且 6s 没动静就收尾
      const snapshot = activeSnapshot();
      if (!snapshot || snapshot.done) return;
      const idleAt = Date.now();
      setTimeout(() => {
        const latest = activeSnapshot();
        if (!latest || latest.done) return;
        if (Date.now() - latest.updatedAt < 5000) return;
        if (idleAt < latest.startedAt) return;
        latest.done = true;
        latest.endReason = "idle";
        // 同样先本地收尾（含提示音），模型概括在后台补
        publishDone(latest, fallbackSummary(latest, "done", cfg.maxChars));
        void summarize("done", { force: true });
      }, 6000).unref?.();
    } catch (error) {
      logger?.warn?.(`dsh-progress-osd: agent/status 处理失败: ${(error as Error)?.message ?? String(error)}`);
    }
  }

  /* ---------------- 轮询兜底 ---------------- */
  async function pollOnce(): Promise<void> {
    if (pollDisabled) return;
    try {
      const response = await (globalThis as { fetch: typeof fetch }).fetch(cfg.pollUrl, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(3000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as Record<string, unknown>;
      pollFailures = 0;
      const state = (body.state ?? body) as Record<string, unknown>;
      if (!state || typeof state !== "object") return;
      eventSeen = true;
      const sessionId = `poll:${String(state.sessionId ?? state.id ?? "default")}`;
      activeSessionId = sessionId;
      const snapshot = snapshotFor(sessionId);
      snapshot.updatedAt = Date.now();
      if (typeof state.action === "string") snapshot.action = state.action;
      if (typeof state.tool === "string") snapshot.action = state.tool;
      if (typeof state.step === "number") snapshot.step = state.step;
      if (typeof state.turn === "number") snapshot.turn = state.turn;
      if (typeof state.label === "string") snapshot.phase = flatten(state.label, 16) || snapshot.phase;
      if (Array.isArray(state.todos)) snapshot.todos = state.todos as TodoItem[];
      pushOsd(
        { label: snapshot.phase, command: snapshot.summary || lastSummary, done: false },
        snapshot.turn === 1 && snapshot.step === 0,
      );
      scheduleSummarize();
    } catch (error) {
      pollFailures += 1;
      const message = (error as Error)?.message ?? String(error);
      // 404/501 = 该接口根本没实现，重试没有意义，立刻停
      const gone = message.includes("HTTP 404") || message.includes("HTTP 501");
      if (gone) stopPolling(`接口不存在（${message}）`);
      else if (pollFailures >= 3) stopPolling(message);
    }
  }

  function stopPolling(reason: string): void {
    if (pollDisabled) return;
    pollDisabled = true;
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    logger?.info?.(`dsh-progress-osd: 已停止轮询兜底（${cfg.pollUrl} / ${reason}），仅依赖 SessionEvent`);
  }

  function startPollingIfNeeded(): void {
    if (pollDisabled || pollTimer) return;
    if (eventSeen) return;
    if (Date.now() - startedAt < 8000) return;
    pollTimer = setInterval(() => {
      void pollOnce();
    }, cfg.pollIntervalMs);
    pollTimer.unref?.();
    void pollOnce();
  }

  /* ---------------- 同 key 冲突提示 ---------------- */
  function detectCoWriter(): void {
    try {
      const table = readOsdState(cfg.osdFile);
      const entry = table[cfg.osdKey];
      if (entry && typeof entry.updated === "number" && Date.now() - entry.updated < 15000) {
        logger?.warn?.(
          `dsh-progress-osd: 检测到另一个写入者正在占用 OSD key "${cfg.osdKey}"（很可能是 dsh-osd-progress）。` +
            "两者会互相抢位，建议在 profile 里禁用其中一个。",
        );
      }
    } catch {
      /* 读不到就算了，不影响主流程 */
    }
  }

  /* ---------------- 启动 ---------------- */
  pruneStaleEntries(cfg.osdFile, logger);
  detectCoWriter();

  ctx.effect?.(
    () => {
      const offs: Array<() => void> = [];
      const subscribe = (event: string, handler: (...args: never[]) => void): void => {
        try {
          const off = ctx.on?.(event, handler, { global: true });
          if (typeof off === "function") offs.push(off as () => void);
        } catch (error) {
          // 少数 ctx 不接受 global 选项：退回普通订阅，最多收不到 scoped 事件，不炸会话。
          try {
            const off = ctx.on?.(event, handler);
            if (typeof off === "function") offs.push(off as () => void);
          } catch (inner) {
            logger?.warn?.(
              `dsh-progress-osd: 订阅 ${event} 失败: ${(inner as Error)?.message ?? String(inner)}（${(error as Error)?.message ?? ""}）`,
            );
          }
        }
      };

      subscribe("session/event", onSessionEvent as unknown as (...args: never[]) => void);
      subscribe("agent/status", onAgentStatus as unknown as (...args: never[]) => void);

      const idleWatch = setInterval(() => {
        startPollingIfNeeded();
      }, 5000);
      idleWatch.unref?.();

      const onExit = (): void => {
        try {
          if (debounceTimer) clearTimeout(debounceTimer);
          if (osdTimer) clearTimeout(osdTimer);
          if (doneTimer) clearTimeout(doneTimer);
          if (pollTimer) clearInterval(pollTimer);
          clearInterval(idleWatch);
          osdShown = true; // 允许 exit 时删掉自己的 key
          clearOsd();
        } catch {
          /* 退出路径上不再抛异常 */
        }
      };
      process.once("exit", onExit);

      return () => {
        process.off("exit", onExit);
        clearInterval(idleWatch);
        if (debounceTimer) clearTimeout(debounceTimer);
        if (osdTimer) clearTimeout(osdTimer);
        if (doneTimer) clearTimeout(doneTimer);
        if (pollTimer) clearInterval(pollTimer);
        debounceTimer = null;
        osdTimer = null;
        doneTimer = null;
        pollTimer = null;
        for (const off of offs) {
          try {
            off();
          } catch {
            /* ignore */
          }
        }
        osdShown = true;
        clearOsd();
      };
    },
    "dsh-progress-osd: 会话进度 → 顶栏 OSD / 桌面通知",
  );
}
