# dsh-progress-osd

把 DSH 会话的进度**概括成一句中文**，同时推到两处：

1. **customshell 顶栏 OSD**：`~/.cache/dsh-osd.json`（协议见 `customshell-arch-config/dsh/OSD-PROTOCOL.md`）
2. **收尾提示音**：`paplay complete.oga`（找不到文件时退回 `canberra-gtk-play`）

系统 toast 默认关闭（`notify: false`）：进度只占顶栏，不打断你做别的事。

概括走 DeepSeek（`deepseek-chat`），带 5 秒防抖、固定 system prompt（命中前缀缓存）、8 秒超时；API 挂了自动降级为本地拼装的文本，功能不中断。

---

## 1. 安装

插件本身**零运行时依赖**（只用 node 内置模块），装进 profile 只是建软链：

```bash
cd ~/.dsh/profiles/web
dsh plugin --profile web add /home/Hbuli/.dsh/plugins/dsh-progress-osd
```

重启 DSH 生效。卸载：

```bash
dsh plugin --profile web remove dsh-progress-osd
```

只有改源码时才需要开发依赖（编译 `src/index.ts` → `dist/index.js`）：

```bash
cd ~/.dsh/plugins/dsh-progress-osd
npm install --save-dev typescript@5.6.3 @types/node@22
npm run build        # tsc -p tsconfig.json
```

DSH 的插件加载器用原生 `import()`，**不转译 TS**，所以 `main` 必须指向编译产物 `dist/index.js`。

### 与旧插件二选一

`dsh-osd-progress`（旧）与本插件都写同一批 `dsh-<pid>` key，会互相抢顶栏位置。安装本插件时已把旧的从 profile 移除：

```bash
dsh plugin --profile web remove dsh-osd-progress
```

---

## 2. 配置

`cordis.patch.yml` 里的 config 会原样传给 `apply(ctx, config)`：

```yaml
- insert:
    - id: progress-osd
      name: 'dsh-progress-osd'
      config:
        model: deepseek-chat
        debounceMs: 5000    # 硬性下限 5000，调小会被压回 5 秒
        maxChars: 30
        notify: false       # 系统 toast，默认关（只要顶栏 + 提示音时不用动）
        notifyLive: false   # true = 运行中也弹通知
        sound: true         # 一轮结束时播提示音
        soundFile: /usr/share/sounds/freedesktop/stereo/complete.oga
```

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 手动指定密钥，**优先级最高**（一般不用设） | 空 → 自动复用 DSH 凭据库 |
| `DEEPSEEK_BASE_URL` | 兼容自建网关 | `https://api.deepseek.com` |
| `DSH_OSD_MODEL` | 覆盖模型 | `deepseek-chat` |
| `DSH_OSD_DEBOUNCE_MS` | 防抖时间（下限 5000） | 5000 |
| `DSH_OSD_NOTIFY` | `1` 打开系统 toast（默认关） | 关 |
| `DSH_OSD_SOUND` | `0` 关闭收尾提示音 | 开 |
| `DSH_OSD_SOUND_FILE` | 提示音文件路径 | `complete.oga` |
| `DSH_OSD_NOTIFY_LIVE` | `1` 运行中也弹通知 | 0 |
| `DSH_OSD_FILE` | OSD 文件路径 | `~/.cache/dsh-osd.json` |
| `DSH_OSD_KEY` | 自己的 OSD key | `dsh-<pid>` |
| `DSH_OSD_POLL_URL` | 轮询兜底接口，空串禁用 | `http://127.0.0.1:3080/agent-status/api/state` |
| `DSH_OSD_CREDENTIALS` | DSH 凭据文件路径 | `$DSH_HOME/.credentials.yaml` |

### 为什么不用单独配 key

DSH 把设置面板里填的 key 存在 `~/.dsh/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`，**并不导出到子进程环境**，所以只读 `process.env` 是拿不到的。本插件的取 key 顺序是：

1. `process.env.DEEPSEEK_API_KEY`（临时覆盖用）
2. `$DSH_HOME/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`（**这就是 DSH 自己用的那把 key**）
3. 都没有 → 本地兜底摘要，功能照常

解析是行级的，不引入 YAML 依赖；结果缓存 60 秒，换 key 后最多一分钟后生效。也就是说：**DSH 能用，插件就能用**，不需要再配一份。

> 另一种"继承"方式是直接调宿主的 `ctx.llm.stream()`（连 key 都不用碰），但那样会用会话当前的模型（通常比 `deepseek-chat` 贵得多），OSD 这种高频小任务不划算，所以没走这条路。

> `agent-status` 接口在本机实测是 **404**：插件只会在「8 秒内没收到任何 SessionEvent」时才去探测，遇到 404/501 立刻停用（只留一条 info 日志），正常使用完全走事件流。

---

## 3. 事件接入（ctx.on 示例）

插件实际订阅的就是这两类：

```ts
export function apply(ctx: ContextLike, config?: Config): void {
  ctx.effect(() => {
    // 唯一关心的来源：会话事件流。必须 global，否则收不到子会话/其他 agent 的事件
    const off = ctx.on("session/event", (session, event) => {
      onSessionEvent(session, event);   // turn/start | tool/call | todo/write | turn/end ...
    }, { global: true });

    // 兜底：事件流断了但 agent 还在跑，靠 status 收尾
    const offStatus = ctx.on("agent/status", (payload) => {
      if (payload?.status === "idle") onAgentStatus(payload);
    });

    return () => { off?.(); offStatus?.(); };
  }, "dsh-progress-osd");
}
```

订阅用的是 `{ global: true }`；若宿主版本不认这个 option，代码会退回无 options 的 `ctx.on` 再试一次，两种情况都不会让插件崩掉。

事件到动作词的映射：

| 事件 | 顶栏 label | 说明 |
|---|---|---|
| `turn/start` | 思考中 | 重置快照、command 清空，`since=now` |
| `step/start` | 思考中 | 步数 +1，等待模型开口 |
| `tool/call` | 执行中 | command 立刻写「动作词 · 参数」，不等模型 |
| `tool/result` | 执行中 | 保持执行态，别急着跳回思考 |
| `assistant/message` | 执行中 | command 跟随模型正在写的内容 |
| `todo/write` | 执行中 | 记录 todos，句末补「待办 2/5」 |
| `turn/end` | 任务已完成 | **立即**本地收尾 + 提示音；模型概括后台补，3 秒后删 key |
| `agent/status=idle` | 任务已完成 | 6 秒无事件时的兜底收尾 |

---

## 4. 成本与稳定性

- **防抖**：任意事件只重置计时器，5000ms 内只发一次请求；`turn/end` 不等，立即发（且立即推送最终结果）。
- **缓存**：`SYSTEM_PROMPT` 是常量字符串，不含时间、步数等变量，DeepSeek 前缀缓存可稳定命中。
- **限额**：`max_tokens: 100`、`temperature: 0`、`stream: false`。
- **超时**：`AbortSignal.timeout(8000)`，超时/非 2xx/解析失败都只记一条 warn 并降级，不阻塞 DSH。
- **并发**：同一时刻只允许一个请求；期间的 `turn/end` 会被排队且**不降级成 running**，等请求结束立刻补发 done。

## 5. 降级与安全

三层兜底，任何一层挂了都还有下一层：

1. DeepSeek 返回 → 直接使用（裁剪到 `maxChars`，压成单行）
2. API 失败/超时/无 key → `fallbackSummary()` 本地拼：`动作 · 细节 · 待办 1/3`
3. OSD 写文件失败 → 只记日志，通知照发

Shell 注入防护：**不用 `exec`，不用字符串拼接**，一律 `execFile` 传数组，并用 `--` 终止选项解析：

```ts
execFile("notify-send",
  ["-a", "DSH 进度", "-i", "utilities-terminal", "-t", "6000", "--", title, body],
  { timeout: 3000 }, callback);
```

`notify-send` 本身也不经过 shell，所以正文里的 `` `id` ``、`$(whoami)`、`; rm -rf` 都只是普通字符（实测 exit=0，无命令执行）。

---

## 6. OSD 协议细节

写入 `~/.cache/dsh-osd.json` 时只用**自己的 key**，读-改-写 + 原子替换（`osd.tmp` → `rename`），因为 QML 每 500ms `cat` 一次：

```json
{ "dsh-631": { "label": "运行命令", "command": "正在改 niri 快捷键", "done": false, "since": 1793815580763, "updated": 1793815671955 } }
```

- `label` 固定 64px 宽、不滚动 → 只放 2~4 个中文字；
- `command` 是跑马灯，放概括（done 态下界面会忽略它，固定显示「任务已完成」）；
- `done: true` 后停留 3 秒再删 key，删 key 是归还顶栏位置的唯一方式；
- 启动时清理 pid 已消失的 `dsh-` 条目，并检测是否有别的进程写同一个 key（有就 warn，提示二选一）。

## 7. 调试

```bash
cat ~/.cache/dsh-osd.json        # 看实时状态
echo '{"dsh-test":{"label":"测试","command":"手写一条","done":false,"since":0,"updated":9999999999999}}' > ~/.cache/dsh-osd.json   # 0.5 秒内出现
```

自测脚本（mock fetch，不碰真实缓存、不弹通知）：

```bash
node ~/_tmp_debug/test-progress-osd.mjs
```
