/**
 * dsh-progress-osd — 把 DSH 会话的「思考内容」直接推到桌面，零联网、零 API 成本。
 *
 * 出口：
 *   1. 顶栏 OSD：按 `~/customshell-arch-config/dsh/OSD-PROTOCOL.md` 写
 *      `~/.cache/dsh-osd.json`（customshell 的 DshOsdState.qml 每 500ms 读一次）。
 *   2. 桌面通知：`notify-send`（默认关闭，见 config.notify）。
 *
 * 思考文本从哪来 —— DSH 没有单独的「思考事件」，reasoning 挂在模型消息事件的
 * stream 数组里（`@deepseek-ai/dsh-llm/lib/types/assistant-stream.d.ts`）：
 *   session/event  event.type = 'assistant/message' | 'assistant/attempt'
 *                  event.data.stream[] 里 type === 'reasoning-chunks' 的 texts 拼接
 *   （没有 reasoning 时按 config.fallbackToText 回退到 'text-chunks'）
 *
 * 其它监听的事件（用于即时进度，纯本地拼装，不发网络请求）：
 *   turn/start | turn/end | step/start | tool/call | tool/result | todo/write
 *   agent/status { status: 'idle' | 'running' }  —— 兜底收尾
 *
 * 防抖：思考是连续吐字的，不能每来一段就弹一次。这里用 trailing debounce ——
 * 每来新思考就重置计时器，静默满 thoughtDebounceMs（默认 4s）才把最新一条推出去。
 *
 * 环境变量（都可选）：
 *   DSH_OSD_DEBOUNCE_MS  思考停顿多久才推，默认 4000
 *   DSH_OSD_MAX_CHARS    推出去的文本上限，默认 400；设 0 表示完全不截断
 *   DSH_OSD_NOTIFY       默认 0；1 打开桌面通知
 *   DSH_OSD_NOTIFY_LIVE  默认 0；1 表示运行中也弹通知
 *   DSH_OSD_SOUND        默认 1；一轮结束播放提示音
 *   DSH_OSD_SOUND_FILE   默认 /usr/share/sounds/freedesktop/stereo/complete.oga
 *   DSH_OSD_KEY          OSD 任务 id，默认 `dsh-<pid>`
 *   DSH_OSD_FILE         默认 ~/.cache/dsh-osd.json
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const name = "dsh-progress-osd";
export const inject: string[] = [];

const APP_NAME = "DSH 思考";
const ICON = "utilities-terminal";
// 顶栏是跑马灯，长句能自己滚，所以上限放宽到 400；0 = 不截断
const DEFAULT_MAX_CHARS = 400;

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
  /** 思考停顿多久才推（毫秒），默认 4000；每次新思考都会重置 */
  thoughtDebounceMs?: number;
  /** 文本上限，默认 50 字符，超出截断并加 "..." */
  maxChars?: number;
  /** 桌面通知（toast），默认 false */
  notify?: boolean;
  /** 运行中也弹通知，默认 false */
  notifyLive?: boolean;
  /** 运行中通知的最小间隔，默认 20000 */
  minNotifyGapMs?: number;
  /** 一轮结束时播放提示音，默认 true */
  sound?: boolean;
  /** 提示音文件；设为空串则改用 canberra 音效名 */
  soundFile?: string;
  /** 完成态在顶栏停留多久，默认 7000 */
  doneHoldMs?: number;
  /** 没有 reasoning 时是否回退到可见正文，默认 true */
  fallbackToText?: boolean;
  /** OSD 文件，默认 ~/.cache/dsh-osd.json */
  osdFile?: string;
  /** OSD 任务 id，默认 `dsh-<pid>` */
  osdKey?: string;
  /** 通知标题，默认「DSH 思考」 */
  title?: string;
  /** 完成提示里附带本轮花费（读 dsh-cost-meter 的账本），默认 true */
  showCost?: boolean;
  /** cost-meter 账本文件，默认 $DSH_HOME/storages/cost-meter/ledger.json */
  costLedgerFile?: string;
  /** 计价货币，默认 CNY（也支持 USD） */
  costCurrency?: "CNY" | "USD";
}

interface ResolvedConfig {
  thoughtDebounceMs: number;
  maxChars: number;
  notify: boolean;
  notifyLive: boolean;
  minNotifyGapMs: number;
  sound: boolean;
  soundFile: string;
  doneHoldMs: number;
  fallbackToText: boolean;
  osdFile: string;
  osdKey: string;
  title: string;
  showCost: boolean;
  costLedgerFile: string;
  costCurrency: "CNY" | "USD";
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
  /** 最近一条清洗后的思考文本 */
  thought: string;
  startedAt: number;
  updatedAt: number;
  done: boolean;
  endReason: string;
  /** 收尾态（OSD done + 提示音）是否已经推过 */
  doneNotified: boolean;
}

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */
const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

const envFlag = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === "") return fallback;
  return !/^(0|false|no|off)$/i.test(value.trim());
};

/** 压平任意值成单行文本（去掉换行、连续空白）。 */
function flatten(value: unknown, limit: number): string {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return truncateChars(text, limit);
}

function truncateChars(value: string, limit: number): string {
  const chars = Array.from(value);
  return chars.length > limit ? chars.slice(0, limit).join("") : value;
}

/**
 * 清洗模型思考文本：
 *   1. 去掉代码块（思考里常带示例代码，占满顶栏没意义）
 *   2. 换行/制表/连续空白 → 单个空格（顶栏是单行跑马灯）
 *   3. 去掉包裹的引号
 *   4. maxChars > 0 且超长时才截断，补 " ..."；maxChars <= 0 表示不截断
 */
export function cleanThought(raw: string, maxChars = DEFAULT_MAX_CHARS): string {
  let text = String(raw ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  // 思考里常带 markdown 强调/编号，顶栏只显示纯文本
  text = text
    .replace(/\*\*|__|`{1,3}|~~/g, "")
    .replace(/(^|\s)#{1,6}\s*/g, " ")
    .replace(/(^|\s)[-*+]\s+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  text = text.replace(/^["'“”‘’「」]+|["'“”‘’「」]+$/g, "").trim();
  if (!text) return "";
  const chars = Array.from(text);
  if (maxChars > 0 && chars.length > maxChars) {
    return `${chars.slice(0, maxChars).join("").trimEnd()} ...`;
  }
  return text;
}

interface StreamRecordLike {
  type?: unknown;
  texts?: unknown;
}

/** 从模型 stream 记录里取指定通道的文本（reasoning-chunks / text-chunks）。 */
export function streamText(stream: unknown, channel: "reasoning-chunks" | "text-chunks"): string {
  if (!Array.isArray(stream)) return "";
  const parts: string[] = [];
  for (const record of stream) {
    if (!record || typeof record !== "object") continue;
    const item = record as StreamRecordLike;
    if (item.type !== channel) continue;
    if (!Array.isArray(item.texts)) continue;
    for (const text of item.texts) {
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("");
}

/* ------------------------------------------------------------------ *
 * OSD 文件协议（见 customshell-arch-config/dsh/OSD-PROTOCOL.md）
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
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, OsdEntry>;
    }
  } catch {
    /* 文件不存在 / 空 / 半截 JSON：当成空表重建 */
  }
  return {};
}

/** 原子写：先写 .tmp 再 rename，避免 QML 每 500ms 的 cat 读到半截 JSON。 */
function writeOsdState(file: string, state: Record<string, OsdEntry>): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(state)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM：进程存在但没有权限发信号 —— 依然算活着
    return (error as { code?: string })?.code === "EPERM";
  }
}

function pruneStaleEntries(file: string, logger?: LoggerLike): void {
  try {
    const table = readOsdState(file);
    let changed = false;
    for (const key of Object.keys(table)) {
      if (!key.startsWith("dsh-")) continue;
      const pid = Number(key.slice(4));
      if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) {
        delete table[key];
        changed = true;
      }
    }
    if (changed) writeOsdState(file, table);
  } catch (error) {
    logger?.warn?.(`dsh-progress-osd: 清理旧 OSD 条目失败: ${(error as Error)?.message ?? String(error)}`);
  }
}

/* ------------------------------------------------------------------ *
 * 工具动作 → 中文动作词 / 简短详情
 * ------------------------------------------------------------------ */
// 顶栏左侧状态词的位置是固定宽度的，最多放 3 个汉字（14px 字号）。
// 所以这里全部压到 3 字以内，宁可短一点也不要出现「运行…」这种省略号。
const ACTION_LABELS: Record<string, string> = {
  bash: "运行",
  read: "读文件",
  write: "写文件",
  edit: "改文件",
  glob: "找文件",
  grep: "搜索",
  ls: "列目录",
  todo_write: "理待办",
  todo: "理待办",
  web_search: "搜网页",
  web_fetch: "抓网页",
  task: "派任务",
  subagent: "派任务",
  ask_user_question: "等确认",
  skill: "载技能",
};

function actionLabel(tool: string): string {
  if (!tool) return "执行中";
  const mapped = ACTION_LABELS[tool];
  if (mapped) return mapped;
  const cleaned = tool.replace(/[_/-]+/g, " ").trim();
  return truncateChars(cleaned || "执行中", 3);
}

function shortDetail(tool: string, rawArguments: unknown): string {
  let args: Record<string, unknown> = {};
  if (typeof rawArguments === "string") {
    try {
      const parsed = JSON.parse(rawArguments) as unknown;
      if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
    } catch {
      return flatten(rawArguments, 40);
    }
  } else if (rawArguments && typeof rawArguments === "object") {
    args = rawArguments as Record<string, unknown>;
  }

  if (typeof args.command === "string") return flatten(args.command, 60);
  if (typeof args.file_path === "string") return flatten(path.basename(args.file_path), 40);
  if (typeof args.path === "string") return flatten(path.basename(args.path), 40);
  if (typeof args.pattern === "string") return flatten(args.pattern, 40);
  if (typeof args.query === "string") return flatten(args.query, 40);
  if (typeof args.description === "string") return flatten(args.description, 40);
  if (typeof args.url === "string") return flatten(args.url, 60);
  return "";
}

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */
function resolveConfig(config: Config | undefined, logger?: LoggerLike): ResolvedConfig {
  const cfg = config ?? {};
  const env = process.env;
  const debounceRaw = env.DSH_OSD_DEBOUNCE_MS ?? cfg.thoughtDebounceMs;
  const maxCharsRaw = env.DSH_OSD_MAX_CHARS ?? cfg.maxChars;
  const soundFile = (env.DSH_OSD_SOUND_FILE ?? cfg.soundFile ?? "").trim();

  const resolved: ResolvedConfig = {
    // 3–5 秒是体感合适的区间；下限 500ms 方便自测，上限 60s 防止手滑写错
    thoughtDebounceMs: clampInt(debounceRaw, 4000, 500, 60000),
    maxChars: clampInt(maxCharsRaw, DEFAULT_MAX_CHARS, 0, 4000),
    notify: envFlag(env.DSH_OSD_NOTIFY, cfg.notify ?? false),
    notifyLive: envFlag(env.DSH_OSD_NOTIFY_LIVE, cfg.notifyLive ?? false),
    minNotifyGapMs: clampInt(cfg.minNotifyGapMs, 20000, 1000, 600000),
    sound: envFlag(env.DSH_OSD_SOUND, cfg.sound ?? true),
    soundFile: soundFile || "/usr/share/sounds/freedesktop/stereo/complete.oga",
    doneHoldMs: clampInt(process.env.DSH_OSD_DONE_HOLD_MS ?? cfg.doneHoldMs, 7000, 0, 60000),
    fallbackToText: cfg.fallbackToText ?? true,
    osdFile: (env.DSH_OSD_FILE ?? cfg.osdFile ?? path.join(os.homedir(), ".cache", "dsh-osd.json")).trim(),
    osdKey: (env.DSH_OSD_KEY ?? cfg.osdKey ?? `dsh-${process.pid}`).trim(),
    title: (env.DSH_OSD_TITLE ?? cfg.title ?? APP_NAME).trim() || APP_NAME,
    showCost: envFlag(env.DSH_OSD_SHOW_COST, cfg.showCost ?? true),
    costLedgerFile: (
      env.DSH_OSD_COST_LEDGER
      ?? cfg.costLedgerFile
      ?? path.join(env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "storages", "cost-meter", "ledger.json")
    ).trim(),
    costCurrency: (env.DSH_OSD_COST_CURRENCY ?? cfg.costCurrency ?? "CNY") === "USD" ? "USD" : "CNY",
  };

  if (resolved.maxChars !== DEFAULT_MAX_CHARS) {
    logger?.info?.(`dsh-progress-osd: 文本上限 ${resolved.maxChars > 0 ? `${resolved.maxChars} 字` : "不截断"}`);
  }
  return resolved;
}

/* ------------------------------------------------------------------ *
 * 花费：读 dsh-cost-meter 的账本（只读，不联网）
 *
 * 账本结构（~/.dsh/storages/cost-meter/ledger.json）：
 *   { days: { "2026-11-05": { costCny, sessions: [
 *       { id: "session-xxx" | "xxx", costCny, cost, at, byProviderModel } ] } } }
 * 同一会话会按天、按调用出现多条记录，所以要按 id 累加；
 * 而且 id 有两种写法（带 / 不带 `session-` 前缀），比对前统一归一化。
 * ------------------------------------------------------------------ */
function normalizeSessionId(id: string): string {
  return id.replace(/^session-/, "");
}

export async function readSessionCost(
  file: string,
  sessionId: string,
  currency: "CNY" | "USD",
): Promise<number | null> {
  try {
    const raw = await fs.promises.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as {
      days?: Record<string, { sessions?: Array<Record<string, unknown>> }>;
    };
    const target = normalizeSessionId(sessionId);
    const field = currency === "USD" ? "cost" : "costCny";
    let total = 0;
    let found = false;
    for (const day of Object.values(parsed.days ?? {})) {
      const list = Array.isArray(day?.sessions) ? day.sessions : [];
      for (const item of list) {
        const id = typeof item?.id === "string" ? normalizeSessionId(item.id) : "";
        if (id !== target) continue;
        const value = item?.[field];
        if (typeof value === "number" && Number.isFinite(value)) {
          total += value;
          found = true;
        }
      }
    }
    return found ? total : null;
  } catch {
    return null;
  }
}

/** 顶栏空间小：一毛以下给 4 位小数（¥0.0031），以上给 2 位（¥1.23） */
export function formatCost(value: number, currency: "CNY" | "USD" = "CNY"): string {
  const symbol = currency === "USD" ? "$" : "¥";
  const digits = value > 0 && value < 0.1 ? 4 : 2;
  return `${symbol}${value.toFixed(digits)}`;
}

/* ------------------------------------------------------------------ *
 * 插件主体
 * ------------------------------------------------------------------ */
export function apply(ctx: ContextLike, config?: Config): void {
  const logger = ctx.logger;
  const cfg = resolveConfig(config, logger);

  /* ---------------- 状态 ---------------- */
  const sessions = new Map<string, Snapshot>();
  let activeSessionId = "";

  let thoughtTimer: Timer | null = null;
  let osdTimer: Timer | null = null;
  let doneTimer: Timer | null = null;
  // 本轮开始时该会话的累计花费（元），用来做差得到「本轮花了多少」
  let turnBaselineCost: number | null = null;
  let lastOsdWrite = 0;
  let lastOsdLabel = "";
  let lastOsdCommand = "";
  let lastOsdDone = false;
  let osdShown = false;
  let since = 0;

  let lastNotifyAt = 0;
  let lastNotifyText = "";

  let warnedNoReasoning = false;
  let sawReasoning = false;

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
      thought: "",
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

    // 协议要求 300ms 节流；内容没变就不重复写盘
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
    const safeTitle = flatten(title, 64) || cfg.title;
    const safeBody = flatten(body, 160);
    if (!safeBody) return;
    // execFile 直接传参数数组、不经过 shell，天然免疫命令注入；
    // `--` 终止选项解析，防止正文以 "-" 开头被当成参数。
    execFile(
      "notify-send",
      ["-a", cfg.title, "-i", ICON, "-t", "6000", "--", safeTitle, safeBody],
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
    notifySend(cfg.title, text);
  }

  /* ---------------- 提示音 ---------------- */
  function playDoneSound(): void {
    if (!cfg.sound) return;
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
      /* 文件探测失败直接走 canberra */
    }
    fallback();
  }

  /* ---------------- 即时本地文本（工具动作，零网络） ---------------- */
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
    return truncateChars(parts.join(" · "), 160);
  }

  /**
   * 顶栏只有一行，信息量最大的内容是「模型在想什么」。
   * 所以一旦有思考文本，command 就常驻它（跑马灯慢慢滚），工具动作只去换 label；
   * 没有思考文本（模型无 reasoning 通道）时才退回本地拼装的动作文本。
   */
  function currentCommand(snapshot: Snapshot): string {
    return snapshot.thought || liveText(snapshot);
  }

  function todoProgress(snapshot: Snapshot): string {
    if (snapshot.todos.length === 0) return "";
    const done = snapshot.todos.filter((item) => item.status === "completed").length;
    return `待办 ${done}/${snapshot.todos.length}`;
  }

  function fallbackSummary(snapshot: Snapshot, stage: "running" | "done"): string {
    const progress = todoProgress(snapshot);
    if (stage === "done") {
      if (snapshot.endReason === "aborted") return cleanThought(["已中止本轮", progress].filter(Boolean).join(" · "), cfg.maxChars);
      if (snapshot.endReason === "error") return cleanThought(["本轮出错", progress].filter(Boolean).join(" · "), cfg.maxChars);
      const action = snapshot.action ? `已完成${actionLabel(snapshot.action)}` : "任务已完成";
      return cleanThought([action, progress].filter(Boolean).join(" · "), cfg.maxChars);
    }
    const parts = [snapshot.phase, snapshot.detail ? truncateChars(snapshot.detail, 18) : "", progress];
    return cleanThought(parts.filter(Boolean).join(" · ") || "正在处理", cfg.maxChars);
  }

  /* ---------------- 思考推送（trailing debounce） ---------------- */
  /**
   * 每来一段新思考就重置计时器：只有「思考停顿了」才把最新一条推出去，
   * 不会连续吐字时刷屏，也不会漏掉最后一句。
   */
  function scheduleThoughtPush(): void {
    if (thoughtTimer) clearTimeout(thoughtTimer);
    thoughtTimer = setTimeout(() => {
      thoughtTimer = null;
      flushThought();
    }, cfg.thoughtDebounceMs);
    thoughtTimer.unref?.();
  }

  function flushThought(): void {
    try {
      const snapshot = activeSnapshot();
      if (!snapshot || snapshot.done) return;
      const text = snapshot.thought;
      if (!text) return;
      pushOsd({ label: "思考中", command: text, done: false }, false);
      if (cfg.notifyLive) notifyThrottled(text);
    } catch (error) {
      logger?.warn?.(`dsh-progress-osd: 推送思考失败: ${(error as Error)?.message ?? String(error)}`);
    }
  }

  /* ---------------- 收尾 ---------------- */
  function publishDone(snapshot: Snapshot, text: string): void {
    if (snapshot.doneNotified) return;
    snapshot.doneNotified = true;
    pushOsd({ label: "任务已完成", command: "", done: true }, false);
    notifySend(cfg.title, text);
    playDoneSound();
    if (doneTimer) clearTimeout(doneTimer);
    doneTimer = setTimeout(() => {
      doneTimer = null;
      clearOsd();
    }, cfg.doneHoldMs);
    doneTimer.unref?.();
  }

  /**
   * 一轮结束后把花费补进完成提示。
   * 账本是 cost-meter 在每次 API 调用后写的，turn/end 当下可能还没落盘，
   * 所以等 1.2 秒再读一次；读不到就什么都不改（顶栏只显示「任务已完成」）。
   */
  function attachCost(sessionId: string): void {
    if (!cfg.showCost) return;
    const startedAt = Date.now();
    const delay = Math.min(1200, Math.max(0, cfg.doneHoldMs - 1200));
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const total = await readSessionCost(cfg.costLedgerFile, sessionId, cfg.costCurrency);
          if (total == null) return;
          const base = turnBaselineCost;
          const spent = base != null ? Math.max(0, total - base) : total;
          if (!(spent > 0)) return;
          // 停留时间快过了就别再写，免得把已删除的 key 又写回来
          if (Date.now() - startedAt > Math.max(500, cfg.doneHoldMs - 400)) return;
          const snapshot = sessions.get(sessionId);
          if (!snapshot?.done) return;
          pushOsd({ label: "任务已完成", command: formatCost(spent, cfg.costCurrency), done: true }, false);
        } catch (error) {
          logger?.warn?.(`dsh-progress-osd: 读取花费失败: ${(error as Error)?.message ?? String(error)}`);
        }
      })();
    }, delay);
    timer.unref?.();
  }

  /* ---------------- 事件 ---------------- */
  /**
   * 从 assistant/message、assistant/attempt 的 stream 里取思考文本。
   * 返回 true 表示拿到了新文本。
   */
  function absorbThought(snapshot: Snapshot, data: Record<string, unknown>): boolean {
    const stream = data.stream;
    let reasoning = streamText(stream, "reasoning-chunks");
    let source: "reasoning" | "text" = "reasoning";
    if (!reasoning && cfg.fallbackToText) {
      source = "text";
      reasoning = streamText(stream, "text-chunks");
      // 有些适配器把正文放在 message.content 里而不是 stream
      if (!reasoning) {
        const message = data.message as { content?: unknown } | undefined;
        const content = message?.content;
        if (typeof content === "string") reasoning = content;
        else if (Array.isArray(content)) {
          reasoning = content
            .map((part) =>
              part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
                ? (part as { text: string }).text
                : "",
            )
            .join(" ");
        }
      }
    }

    const cleaned = cleanThought(reasoning, cfg.maxChars);
    if (!cleaned) return false;

    if (source === "reasoning" && !sawReasoning) {
      sawReasoning = true;
      logger?.info?.("dsh-progress-osd: 已接入模型 reasoning 流");
    }
    if (source === "text" && !sawReasoning && !warnedNoReasoning) {
      warnedNoReasoning = true;
      logger?.info?.("dsh-progress-osd: 该模型没有 reasoning 通道，回退到可见正文");
    }

    snapshot.thought = cleaned;
    return true;
  }

  function onSessionEvent(session: SessionLike, event: SessionEventLike): void {
    try {
      const type = event?.type;
      if (!type) return;
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
        if (thoughtTimer) {
          clearTimeout(thoughtTimer);
          thoughtTimer = null;
        }
        turnBaselineCost = null;
        if (cfg.showCost) {
          const id = sessionId;
          void readSessionCost(cfg.costLedgerFile, id, cfg.costCurrency).then((value) => {
            if (activeSessionId === id) turnBaselineCost = value;
          });
        }
        pushOsd({ label: "思考中", command: "", done: false }, true);
        return;
      }

      if (type === "step/start") {
        snapshot.step = Number(data.step ?? snapshot.step);
        snapshot.phase = "思考中";
        pushOsd({ label: "思考中", command: currentCommand(snapshot), done: false }, false);
        return;
      }

      if (type === "step/end") {
        snapshot.step = Number(data.step ?? snapshot.step);
        return;
      }

      // 思考正文：模型一步结束时一次性给出完整 stream
      if (type === "assistant/message" || type === "assistant/attempt") {
        if (snapshot.done) return;
        const message = data.message as { content?: unknown } | undefined;
        const content = message?.content;
        if (typeof content === "string") snapshot.lastText = flatten(content, 400);
        else if (Array.isArray(content)) {
          snapshot.lastText = flatten(
            content
              .map((part) =>
                part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
                  ? (part as { text: string }).text
                  : "",
              )
              .join(" "),
            400,
          );
        }
        // 先让工具动作的即时文本落一下，再排队思考（思考停顿 4s 后覆盖它）
        if (absorbThought(snapshot, data)) scheduleThoughtPush();
        return;
      }

      if (type === "tool/call") {
        snapshot.action = typeof data.name === "string" ? data.name : "";
        snapshot.detail = shortDetail(snapshot.action, data.arguments);
        snapshot.phase = actionLabel(snapshot.action);
        // label 显示具体动作（运行命令/读文件/搜索），command 继续滚思考
        pushOsd({ label: actionLabel(snapshot.action), command: currentCommand(snapshot), done: false }, false);
        return;
      }

      if (type === "tool/result") {
        snapshot.phase = "执行中";
        pushOsd({ label: "执行中", command: currentCommand(snapshot), done: false }, false);
        return;
      }

      if (type === "todo/write") {
        const todos = Array.isArray(data.todos) ? (data.todos as TodoItem[]) : [];
        snapshot.todos = todos.filter(
          (item) => item && typeof item.content === "string" && typeof item.status === "string",
        );
        pushOsd({ label: "执行中", command: currentCommand(snapshot), done: false }, false);
        return;
      }

      if (type === "turn/end") {
        const reason = data.reason as { kind?: string } | undefined;
        snapshot.endReason = typeof reason?.kind === "string" ? reason.kind : "completed";
        snapshot.done = true;
        if (thoughtTimer) {
          clearTimeout(thoughtTimer);
          thoughtTimer = null;
        }
        // 收尾文本：优先用本段最后的思考，其次本地规则兜底（都不联网）
        const finalText = snapshot.thought || fallbackSummary(snapshot, "done");
        publishDone(snapshot, finalText);
        attachCost(sessionId);
        return;
      }
    } catch (error) {
      logger?.warn?.(`dsh-progress-osd: session/event 处理失败: ${(error as Error)?.message ?? String(error)}`);
    }
  }

  function onAgentStatus(payload: { status?: string } | undefined): void {
    try {
      if (payload?.status !== "idle") return;
      // 兜底：turn/end 没等到（异常退出 / 取消），idle 且 6s 没动静就收尾
      const snapshot = activeSnapshot();
      if (!snapshot || snapshot.done) return;
      setTimeout(() => {
        const latest = activeSnapshot();
        if (!latest || latest.done) return;
        if (Date.now() - latest.updatedAt < 5000) return;
        latest.done = true;
        latest.endReason = "idle";
        publishDone(latest, latest.thought || fallbackSummary(latest, "done"));
      }, 6000).unref?.();
    } catch (error) {
      logger?.warn?.(`dsh-progress-osd: agent/status 处理失败: ${(error as Error)?.message ?? String(error)}`);
    }
  }

  /* ---------------- 同 key 冲突提示 ---------------- */
  function detectCoWriter(): void {
    try {
      const table = readOsdState(cfg.osdFile);
      const entry = table[cfg.osdKey];
      if (entry && typeof entry.updated === "number" && Date.now() - entry.updated < 15000) {
        logger?.warn?.(
          `dsh-progress-osd: 检测到另一个写入者正在占用 OSD key "${cfg.osdKey}"（很可能是旧的 dsh-osd-progress）。` +
            "两者会互相抢位，建议在 profile 里禁用其中一个。",
        );
      }
    } catch {
      /* 读不到就算了 */
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
              `dsh-progress-osd: 订阅 ${event} 失败: ${(inner as Error)?.message ?? String(error)}`,
            );
          }
        }
      };

      subscribe("session/event", onSessionEvent as unknown as (...args: never[]) => void);
      subscribe("agent/status", onAgentStatus as unknown as (...args: never[]) => void);

      const onExit = (): void => {
        try {
          if (thoughtTimer) clearTimeout(thoughtTimer);
          if (osdTimer) clearTimeout(osdTimer);
          if (doneTimer) clearTimeout(doneTimer);
          osdShown = true; // 允许 exit 时删掉自己的 key
          clearOsd();
        } catch {
          /* 退出路径上不再抛异常 */
        }
      };
      process.once("exit", onExit);

      return () => {
        process.off("exit", onExit);
        if (thoughtTimer) clearTimeout(thoughtTimer);
        if (osdTimer) clearTimeout(osdTimer);
        if (doneTimer) clearTimeout(doneTimer);
        thoughtTimer = null;
        osdTimer = null;
        doneTimer = null;
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
    "dsh-progress-osd: 模型思考 → 顶栏 OSD",
  );
}
