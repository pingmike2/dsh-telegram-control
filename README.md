# dsh-telegram-control

**[简体中文](README.md)** | [English](README.en.md)

DSH 的**系统级** Telegram 控制台：装上之后，整个 DeepSeek Harness（所有会话、所有 preset）都能从一个 Telegram Bot 远程操控。

- 纯 Host 插件，零第三方依赖（只用 Node 内建模块），安装即生效，不需要 `pnpm` 拉包。
- 只挂一次：进程级单例，不跟随 agent preset，所有 Session 共用同一个 Bot。
- 会思考，但不吵人：**思考过程默认不上屏**，Telegram 侧只显示「正在输入…」状态，只把最终回答发出来。

## 安装

```text
plugin_manager install_bundle  target = <本目录绝对路径>
```

安装后自动在 profile 的 `cordis.patch.yml` 前插入 `telegram-control` 行。

## 上线（不需要重启 DSH）

**图形化方式**：插件启动后会在本机开一个配置页 —— <http://127.0.0.1:59777/>

填 `botToken`、`allowedUserIds` / `allowedChatIds`、代理与开关（含语言、思考状态），点「保存并生效」，5 秒内轮询自动启动。`/status` 端点返回运行快照 JSON，便于脚本探活；`/health` 返回 `{"ok":true}`。

**文件方式**：编辑 `%DSH_HOME%\telegram-control.json`（默认 `C:\Users\<你>\.dsh\telegram-control.json`），首次运行自动生成模板；该文件**每 5 秒热加载**。

```json
{
  "botToken": "123456:ABC...",
  "allowedUserIds": [123456789],
  "allowedChatIds": [123456789],
  "workingDirectory": "F:\\work",
  "agentPreset": "",
  "proxyUrl": "auto",
  "configPort": 59777,
  "lang": "zh",
  "answerApprovals": false,
  "answerQuestions": false,
  "forwardReasoning": false,
  "thinkingStatus": "typing"
}
```

1. 找 @BotFather 要 token，填 `botToken`。
2. 给 Bot 发 `/myid`，把你看到的 `user_id` / `chat_id` 填进白名单 —— **两个白名单都为空时一切消息都会被拒绝**，`/myid` 和 `/help` 除外（用于首次取号）。
3. 保存，5 秒内轮询自动启动；改 token 会平滑重启轮询，改白名单/开关立即生效。

## 命令菜单（输入 / 弹候选）

轮询启动时会自动调用 `setMyCommands`，把 **41 条**命令注册到 **default / 私聊 / 群聊** 三个作用域，并把菜单按钮设为 `commands`，所以输入框敲 `/` 就会弹出带说明的候选列表（文案跟随语言）。

- 注册失败或客户端没刷新：发 `/menu`（别名 `/commands`）重新注册，然后切出再切回聊天。
- 同时会设置 Bot 的简介与描述（`setMyShortDescription` / `setMyDescription`），在 Telegram 的 Bot 资料页直接能看懂它能干什么。
- 状态文件里的 `botCommands` 字段就是已注册条数；`GET /status` 同样能看到。

## 多语言（i18n）

界面文案走 `locale/*.json`：**扁平 key → 模板**，支持 `{placeholder}` 插值，缺 key 回退 `zh`。

| 文件 | 语言 |
|---|---|
| `locale/zh.json` | 简体中文（默认） |
| `locale/en.json` | English |

- `/lang` 查看当前语言与可选列表，`/lang en` / `/lang zh` 切换：**立刻重注册命令菜单**、重渲染所有回复，并把 `lang` 落盘（热加载后保持）。
- 配置页的下拉框直接读 `locale/*.json` 的 `$meta.label`，新增一个 `locale/xx.json` 就能多一门语言，不用改代码。
- 翻译只覆盖"给人看的文案"：命令名、日志里的英文技术细节保持原样。
- 文档本身也是双语的：本文件（中文，默认）与 [README.en.md](README.en.md)。

## 思考过程与状态提示

模型在思考时会产生大量 `reasoning` 增量。这些**一律不上屏**（Web UI 用它们，Telegram 不需要），插件只做两件事：

1. 给聊天发一个 `sendChatAction: typing` —— 手机上就是「对方正在输入…」，节流 4 秒一次，不会刷屏。
2. 最终 `assistant/message` 的 `text` 块才是回答，正常发出来。

**工具调用同样不上屏**：`tool/call`（`🔧 edit`、`🔧 pwsh` 那种）只用来刷新「正在输入…」状态，一条消息都不发；`tool/result` 只在**失败**时发一行 `⚠️ 工具失败：…`。所以手机上看到的永远是：状态在动 → 最终回答。

| 开关 | 默认 | 说明 |
|---|---|---|
| `forwardReasoning` | `false` | `/reasoning on` 后把思考内容也发出来（带 `🧠 思考` 前缀），排查问题时用 |
| `thinkingStatus` | `typing` | `typing`（只发状态）/ `message` / `off`（完全不发） |

## 网络与代理

Node 的 `fetch`（undici）**不读 Windows 系统代理**，所以在需要代理才能访问 `api.telegram.org` 的网络里会直接 `UND_ERR_CONNECT_TIMEOUT`（表现就是状态文件 `degraded` + `errors` 一直涨）。

`proxyUrl` 三种取值：

| 值 | 行为 |
|---|---|
| `auto`（默认） | 读注册表 `HKCU\...\Internet Settings` 的 `ProxyServer`，自动套用（如 `http://127.0.0.1:10808`） |
| `http://host:port` | 显式指定 HTTP 代理 |
| `none` | 强制直连（测试或内网中转时用） |

走代理时插件用 `node:http` 发 `CONNECT`，再在隧道上手工讲 HTTP/1.1（`node:tls` 包一层 TLS）—— 零依赖，且改配置立即生效，不用重启 Harness。

## 运行状态（无需 Telegram 即可确认）

每次监督轮询都会写 `%DSH_HOME%\telegram-control-status.json`：

```json
{
  "version": "1.2.0",
  "state": "running",
  "pid": 3900,
  "startedAt": 1792418496591,
  "updatedAt": 1792418496591,
  "bot": "@your_bot",
  "botCommands": 41,
  "chats": 1,
  "boundSessions": 1,
  "approvalsEnabled": true,
  "questionsEnabled": true,
  "stats": { "updates": 12, "messages": 9, "errors": 0 }
}
```

`state` 取值：`waiting-token`（等待配置）/ `running`（轮询中）/ `degraded`（轮询报错重试）/ `stopped`（已卸载或禁用）/ `disabled`。`updatedAt` 每 5 秒刷新——**它就是"插件是否活着"的心跳**。运行时还会带 `stats: { updates, messages, errors, lastUpdateAt, lastError }`，`bot` 字段里的 token 只保留 `id:***末4位`。

## 命令

| 分类 | 命令 |
|---|---|
| 会话 | `/sessions`（按钮直接切换） `/new [目录] [\| 标题]` `/use <序号\|id\|标题>` `/info` `/cancel` `/fork` `/rename <标题>` |
| 对话 | 直接发文本（下发 prompt，最终回答/回合状态回流）、`/models` `/model <provider> <model>` `/presets` |
| 直接控制 | `/shell <命令>` `/cd` `/pwd` `/ls [路径]` `/read <路径>` `/write <路径>⏎内容` `/tools` `/tool <名称> [JSON]` |
| 审批/提问 | `/approvals on\|off`（接管工具执行审批，内联按钮）、`/questions on\|off`（接管 `ask_user_question`）、`/reasoning on\|off` |
| 插件 | `/plugins` `/plugin enable\|disable <patchId>` `/bundles` `/install <包>` `/uninstall <名称>` |
| 主机 | `/power` `/shutdown [秒\|now]` `/reboot [秒\|now]` `/cancel` `/lock` `/sleep` `/hibernate` |
| 其它 | `/status` `/menu` `/pause` `/resume` `/myid` `/version` `/lang zh\|en` `/help` |

### 会话命名与切换

- **新建时就取名**：`/new 重构登录页` → 建好即调用 `rename`，标题写进会话投影。带目录再加 `|`：`/new F:\work\app | 重构登录页`。没有 `|` 时按内容判断——含路径分隔符或目录真实存在就当目录，否则当标题。
- **按标题切换**：`/use 重构登录页`（精确 → 不区分大小写），`/use 登录`（唯一命中时模糊匹配），`/use 3` `/use #3`（`/sessions` 的序号），`/use 9f3a12`（sessionId 前缀）。
- **点按钮切换**：`/sessions` 会附 12 个内联按钮（`s:<序号>`），点一下就绑定，并回一条「已绑定会话：标题」。
- **看标题**：`/info` 显示当前会话的标题/ID/目录/状态/事件数，`/status` 里也有「当前会话：标题 · id」。
- 匹配到多个会话时不会瞎猜，直接把候选列出来让你用序号或更精确的标题重试；非 ID 形态的字符串（含中文）不会被当成 sessionId。

### 主机电源控制（关机 / 重启 / 锁屏）

从旧机器人搬过来的能力，一条命令即可远程关掉这台机器：

| 命令 | 作用 |
|---|---|
| `/power` | 主机与电源状态：主机名、平台、进程运行时长、内存、CPU 核数、是否允许、计划中的任务、上次操作 |
| `/shutdown` | 默认 60 秒后关机（`powerDefaultSeconds` 可改） |
| `/shutdown 300` | 300 秒后关机（最大 86400 秒） |
| `/shutdown now` | 立即关机 —— **必须点内联按钮确认**，防手滑 |
| `/reboot` `/restart` | 同样支持空参数 / 秒 / `now` |
| `/shutdown cancel` | 撤销计划中的关机或重启（等同 `shutdown /a`） |
| `/cancel` | 取消当前回合；若存在计划中的关机，**同时撤销**（兼容旧习惯） |
| `/lock` | 锁屏（`rundll32 user32.dll,LockWorkStation`） |
| `/sleep` `/hibernate` | 睡眠 / 休眠（休眠需系统已启用） |

安全设计：

- `allowPower` 开关（配置页可关）；关掉后所有电源命令直接拒绝。
- **≤10 秒的关机/重启必须按钮确认**：`p:<token>:1` 执行、`p:<token>:0` 取消，token 一次性。
- 默认 60 秒倒计时，留出反悔窗口；`/cancel` 立刻撤销。
- 退出码翻译：`1190`（已有计划任务）、`1116`（没有计划任务）、`5`（权限不足）、`1`（参数错误）。
- `powerExec` 可替换 `shutdown` 命令本身（指向自定义可执行体；给 `.js/.mjs/.cjs` 时用当前 Node 解释执行），测试就靠它注入假实现，绝不会真关机。
- 非 Windows 平台自动改用 `systemctl poweroff/reboot`、`pmset sleepnow`、`loginctl lock-session`。

## 实现要点

- **会话桥接**：`ctx.get('sessionController')` → `create / prompt / follow / cancel / fork / rename / selectModel`，与 Web UI 走同一条 Host API；`follow` 流按 seq 去重，只转发绑定之后的新事件。
- **审批接管**：注册 `approval/request` waterfall，把请求推到 Telegram 并等内联按钮；超时按 `cancelled`（fail-closed）；未绑定会话或不接管时原样 `next()`，不干扰 Web UI。**开关会落盘**，热加载不会把它重置。
- **提问接管**：注册 `user-questions/request` waterfall，单问题映射为按钮 + 自由文本回复；超时交回 Harness。
- **工具直调**：`ctx.get('tools').execute({ callId, name, arguments, agent, signal })`，带超时 AbortSignal。
- **shell**：`node:child_process` 直接起进程（Windows 依次尝试 `pwsh` → `powershell` → `cmd`），输出上限 200KB、可设超时。
- **状态持久化**：chat → session 绑定写入 `%DSH_HOME%\telegram-control-state.json`（防抖 800ms）。
- **安全开关**：`allowShell` / `allowTools` / `allowFs` / 白名单；默认全部需要显式授权用户。

## 测试

```text
npm test          # 等价于 node test/tg-control.test.mjs
```

本地起一个假的 Bot API（真 http server，走 `getUpdates` 长轮询）+ 假的 Cordis ctx / `sessionController` / `tools` / `pluginManager`，真跑插件：命令菜单注册、鉴权、命令分发、prompt 桥接、流式事件回流、**思考过程不上屏与 typing 节流**、i18n 切换、shell / 文件 / 工具直调、审批与提问内联按钮、会话命名与切换、电源控制（含二次确认与 `allowPower` 关闭）、配置页 CSRF 与保存、热加载、卸载清理。

当前：**117 项断言全部通过**。测试用 `powerExec` 指向 `test/fixtures/fake-shutdown.mjs`，**绝不会真的关机**。

## 设计取舍

- 不声明 `inject`：所有服务在调用点用 `ctx.get()` 软解析，缺服务时命令给出可读错误而不是让整行插件失活。
- 不用 `Config` schema：避免引入 `@deepseek-ai/schemastery` 依赖，配置走热加载 JSON，改完无需重启。
- 不用长轮询以外的接入方式：Bot API `getUpdates` 不需要公网入口，本机即可运行。

## License

MIT
