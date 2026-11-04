# dsh-progress-osd

把 DSH 会话里**模型自己的思考（reasoning）**直接推到 customshell 顶栏：零联网、零 API 成本。

1. **顶栏 OSD**：写 `~/.cache/dsh-osd.json`（协议见 `customshell-arch-config/dsh/OSD-PROTOCOL.md`）
2. **收尾提示音**：`paplay complete.oga`（找不到文件时退回 `canberra-gtk-play`）
3. **系统 toast**：默认关闭（`notify: false`），需要时一个开关打开

---

## 1. 它监听什么事件

DSH **没有单独的「思考事件」**。思考文本挂在模型消息事件的 `stream` 数组里，记录类型是 `reasoning-chunks`：

| 事件 | 用途 | 字段路径 |
|---|---|---|
| `session/event` → `assistant/message` | 一步模型输出完成（正常） | `event.data.stream[]` 里 `type === 'reasoning-chunks'` 的 `texts` 数组拼接 |
| `session/event` → `assistant/attempt` | 这一步失败/重试，同样有流 | 同上 |
| `session/event` → `turn/start` / `turn/end` | 一轮开始 / 结束 | 重置状态；结束收尾 |
| `session/event` → `tool/call` / `tool/result` / `todo/write` | 即时进度（纯本地拼装，不发网络） | 工具名 + 参数摘要 |
| `agent/status` → `idle` | 兜底收尾（`turn/end` 没等到时） | — |

类型定义在 `@deepseek-ai/dsh-llm/lib/types/assistant-stream.d.ts`：

```ts
export type AssistantStreamRecord = { type: 'reasoning-chunks'; index: number; texts: readonly string[]; ... }
```

`texts` 是**分片**（如 `["用户","要求","编写"]`），必须拼接后再展示，不能取其中一片。

## 2. 防抖与清洗

- **trailing debounce**：每来一段新思考就重置计时器，静默满 `thoughtDebounceMs`（默认 4000ms）才推**最新一条**。连续吐字时不会刷屏。
- **清洗**：去代码块 → 换行/连续空白压成单个空格 → 去包裹引号。
- **截断**：超过 `maxChars`（默认 50）个字符直接截断，补 `" ..."`。
- **兜底**：模型没有 reasoning 通道时（`fallbackToText: true`），回退到同一 stream 的 `text-chunks`，再不行读 `message.content`。

## 3. 安装

插件本身**零运行时依赖**（只用 node 内置模块），装进 profile 只是建软链：

```bash
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

`dsh-osd-progress`（旧）与本插件都写 `dsh-<pid>` key，会互相抢顶栏位置。安装本插件时已把旧的从 profile 移除：

```bash
dsh plugin --profile web remove dsh-osd-progress
```

## 4. 配置

`cordis.patch.yml` 里的 `config` 原样传给 `apply(ctx, config)`；环境变量优先级更高。

| 键 / 环境变量 | 默认 | 说明 |
|---|---|---|
| `thoughtDebounceMs` / `DSH_OSD_DEBOUNCE_MS` | `4000` | 思考停顿多久才推 |
| `maxChars` / `DSH_OSD_MAX_CHARS` | `50` | 文本上限，超出截断加 `...` |
| `notify` / `DSH_OSD_NOTIFY` | `false` | 是否弹系统 toast |
| `notifyLive` / `DSH_OSD_NOTIFY_LIVE` | `false` | 运行中也弹 toast |
| `sound` / `DSH_OSD_SOUND` | `true` | 一轮结束播放提示音 |
| `soundFile` / `DSH_OSD_SOUND_FILE` | `complete.oga` | 提示音文件 |
| `doneHoldMs` / `DSH_OSD_DONE_HOLD_MS` | `3000` | 完成态停留多久后收回顶栏 |
| `fallbackToText` | `true` | 无 reasoning 时回退正文 |
| `osdKey` / `DSH_OSD_KEY` | `dsh-<pid>` | OSD 任务 id |
| `osdFile` / `DSH_OSD_FILE` | `~/.cache/dsh-osd.json` | OSD 状态文件 |
| `title` / `DSH_OSD_TITLE` | `DSH 思考` | toast 标题 |

## 5. 顶栏显示规则

- `label`：`思考中` / `执行中` / `任务已完成`，固定宽度不滚动
- `command`：思考清洗后的单行文本，走跑马灯
- `done: true` 时界面忽略 command，固定显示「任务已完成」并变绿；**停留 `doneHoldMs` 后删 key**（删 key 才是归还位置的唯一方式）
- 写入是原子的（`.tmp` + rename，QML 每 500ms `cat` 一次），300ms 节流

## 6. 容错

- 整个事件处理、OSD 写盘、通知、音效都在 `try/catch` 里，坏事件（`arguments` 不是合法 JSON、`stream` 不是数组）只记日志不抛。
- `notify-send` 走 `execFile` 参数数组，不经过 shell，天然免疫命令注入；附带 `--` 防止正文以 `-` 开头被当成选项。
- 收尾提示音 `paplay` 失败会自动退回 `canberra-gtk-play -i complete`。

## 7. 调试

```bash
cat ~/.cache/dsh-osd.json          # 看当前 OSD 内容
journalctl --user -u dsh-web.service -f | grep progress-osd
```

手写一条测界面：

```bash
python3 - <<'EOF'
import json, os, time
p = os.path.expanduser("~/.cache/dsh-osd.json")
d = json.load(open(p)) if os.path.exists(p) else {}
now = int(time.time()*1000)
d["dsh-test"] = {"label":"思考中","command":"这是一条测试思考文本，用来验证跑马灯","done":False,"since":now,"updated":now}
json.dump(d, open(p,"w"))
EOF
```

删掉 `dsh-test` 这条 key，顶栏 0.5 秒内收回。
