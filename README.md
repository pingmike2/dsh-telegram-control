# dsh-telegram-control

**[简体中文](README.md)** | [English](README.en.md) · 作者 [pingmike2](https://github.com/pingmike2) · 仓库 [pingmike2/dsh-telegram-control](https://github.com/pingmike2/dsh-telegram-control)

DSH 的**系统级** Telegram 控制台：装上之后，整个 DeepSeek Harness（所有会话、所有 preset）都能从一个 Telegram Bot 远程操控。

- 纯 Host 插件，零第三方依赖（只用 Node 内建模块），安装即生效，不需要 `pnpm` 拉包。
- 只挂一次：进程级单例，不跟随 agent preset，所有 Session 共用同一个 Bot。
- 会思考，但不吵人：**思考过程默认不上屏**，Telegram 侧只显示「正在输入…」状态，只把最终回答发出来。

> ⚠️ 这个插件能远程执行命令、关机、改文件。上线前务必配好 `allowedUserIds` / `allowedChatIds` 白名单，不用的能力用 `allowShell` / `allowTools` / `allowFs` / `allowPower` 关掉。

## 架构

```text
Telegram 手机端
  │  /命令、文本 prompt、内联按钮回调
  ▼
getUpdates 长轮询（proxyUrl: auto=读 Windows 系统代理 / 显式 http:// / none=直连）
  ▼
telegram-control（Host 插件，process 级单例）
  ├─ 白名单校验（allowedUserIds / allowedChatIds，两者都填取交集）
  ├─ 命令分发（41 条：会话 / 对话 / shell / 文件 / 审批 / 插件 / 电源 / i18n）
  ├─ sessionController（Host API：create / prompt / follow / cancel / fork / rename / selectModel）
  │    └─ follow 流按 seq 去重 → assistant 回答回流 Telegram；思考过程不上屏，只发 typing 心跳
  ├─ approval/request 与 user-questions/request waterfall → 内联按钮接管（超时 fail-closed / 交回 Harness）
  └─ 本机配置页 http://127.0.0.1:59777/（CSRF 保护，GET /config /status /health，POST /save）
       └─ 改 telegram-control.json → 每 reloadSeconds(默认 5s) 热加载，无需重启 DSH

状态落盘：%DSH_HOME%\telegram-control-state.json（chat↔session 绑定）
         %DSH_HOME%\telegram-control-status.json（运行快照，深度见「运行状态」）
```

## 安装

两种姿势，选一种：

**A. git 拉仓库**（更新方便，`git pull` 即可升级）：

```text
git clone https://github.com/pingmike2/dsh-telegram-control.git
plugin_manager install_bundle  target = <clone 出来的目录绝对路径>
```

**B. 下载发布包**（没 git / 不想 clone；Windows 用户右键可直接解压 zip）：

```text
1. 到 https://github.com/pingmike2/dsh-telegram-control/releases/latest 下载 dsh-telegram-control-<版本>.zip
2. 解压到任意目录
3. plugin_manager install_bundle  target = <解压目录绝对路径>
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
  "thinkingStatus": "typing",
  "format": "markdown",
  "notifyToolFailures": false,
  "allowShell": true,
  "allowTools": true,
  "allowFs": true,
  "allowPower": true,
  "powerDefaultSeconds": 60,
  "powerExec": "",
  "shellPath": "",
  "maxMessageChars": 3600,
  "approvalTimeoutSeconds": 120,
  "commandTimeoutSeconds": 120,
  "reloadSeconds": 5
}
```

### 配置项全集（真名 + 真默认值，与代码一一对应）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件总开关，`false` 时轮询停、状态 `disabled` |
| `lang` | `zh` | 界面语言，取 `locale/*.json` 里支持的代码（当前 `en` / `zh`），非法值回退 `zh` |
| `botToken` | 空 | BotFather 的 token；为空则插件停在 `waiting-token` |
| `apiBaseUrl` | `https://api.telegram.org` | Bot API 地址（第三方中转可改） |
| `proxyUrl` | `auto` | `auto`=读 Windows 系统代理；显式 `http://host:port`；`none`/`off`/`direct`=强制直连 |
| `configPort` | `59777` | 本机配置页端口，`0`=关闭；只监听 `127.0.0.1` |
| `allowedUserIds` / `allowedChatIds` | 空 | 白名单；两者都非空取交集，都以数字填 |
| `workingDirectory` | 空 | 默认工作目录；留空用 DSH 默认 |
| `agentPreset` | 空 | 新会话用的 agent preset；留空 `standard` |
| `pollTimeoutSeconds` | `25` | `getUpdates` 长轮询时长（1–50）；走 Cloudflare 反代建议 `15` |
| `apiTimeoutSeconds` | `30` | 除长轮询外每个 Bot API 请求的超时（5–120）。中继把连接挂住时靠它脱身，否则这个聊天的后续命令全被堵死 |
| `maxMessageChars` | `3600` | 单条消息上限（200–4096），超出自动分段 |
| `answerApprovals` | `false` | 接管工具审批 → Telegram 内联按钮，超时按拒绝处理 |
| `answerQuestions` | `false` | 接管 `ask_user_question` → 按钮/自由文本 |
| `forwardReasoning` | `false` | `/reasoning on` 后推送思考内容 |
| `thinkingStatus` | `typing` | `typing` / `message` / `off` |
| `format` | `markdown` | `markdown`（MarkdownV2+纯文本兜底）/ `plain` |
| `notifyToolFailures` | `false` | 工具失败是否推送到 Telegram |
| `approvalTimeoutSeconds` | `120` | 审批按钮等待上限（10–3600） |
| `commandTimeoutSeconds` | `120` | `/shell` `/tool` 执行超时（1–3600） |
| `allowShell` / `allowTools` / `allowFs` / `allowPower` | `true` | 四类能力开关，按需关闭 |
| `powerDefaultSeconds` | `60` | `/shutdown` 无参数时的倒计时（0–86400） |
| `powerExec` | 空 | 自定义关机命令路径；`.js/.mjs/.cjs` 用当前 Node 执行（测试注入用） |
| `shellPath` | 空 | 自定义 shell；留空 Windows 依次试 `pwsh`→`powershell`→`cmd`，其余平台 `/bin/bash -lc` |
| `reloadSeconds` | `5` | 配置热加载间隔（2–600） |

1. 找 @BotFather 要 token，填 `botToken`。
2. 给 Bot 发 `/myid`，把你看到的 `user_id` / `chat_id` 填进白名单 —— **两个白名单都为空时一切消息都会被拒绝**，`/myid` 和 `/help` 除外（用于首次取号）。
3. 保存，5 秒内轮询自动启动；改 token 会平滑重启轮询，改白名单/开关立即生效。

## 命令菜单（输入 / 弹候选）

轮询启动时会自动调用 `setMyCommands`，把 **41 条**命令注册到 **default / 私聊 / 群聊** 三个作用域，并把菜单按钮设为 `commands`，所以输入框敲 `/` 就会弹出带说明的候选列表（文案跟随语言）。

- 注册失败或客户端没刷新：发 `/menu`（别名 `/commands`）重新注册，然后切出再切回聊天。
- 同时会设置 Bot 的简介与描述（`setMyShortDescription` / `setMyDescription`），在 Telegram 的 Bot 资料页直接能看懂它能干什么。
- 状态文件里的 `botCommands` 字段就是已注册条数；`GET /status` 同样能看到。

## 思考过程与状态提示

模型在思考时会产生大量 `reasoning` 增量。这些**一律不上屏**（Web UI 用它们，Telegram 不需要），插件只做两件事：

1. 给聊天发一个 `sendChatAction: typing` —— 手机上就是「对方正在输入…」。**这一轮只要还在跑，心跳就每 4 秒续一次**，中间连续跑十分钟工具也是常亮状态，远程瞄一眼就知道 DSH 没闲着；`turn/end` 到就停，超过 3 分钟没有任何会话事件也会自动收掉。
2. 最终 `assistant/message` 的 `text` 块才是回答，正常发出来。

**工具调用同样不上屏**：`tool/call`（`🔧 edit`、`🔧 pwsh` 那种）只用来刷新「正在输入…」状态，一条消息都不发；`tool/result` 的**失败默认也不推**——`ToolNotFoundError`、`WebError` 这类是 agent 自己会重试或绕过的中间态，推到手机上纯噪音，只写进日志。要排查时把 `notifyToolFailures` 打开，才会收到一行 `⚠️ 工具失败：…`。所以手机上看到的永远是：状态在动 → 最终回答。

消息按 Markdown 渲染：回答里的标题会变粗体、代码块进等宽块、`*` `_` `.` 这类保留字符自动转义，不再原样显示源码。表格没有 MarkdownV2 语法，等宽块在手机上换行还会错位，所以**翻成键值行**：两列变 `• 项目：结果`，多列变 `• 表头：值 · 表头：值`。哪条消息 Telegram 解析不了，就自动退回纯文本重发一次。

行内代码（`反引号包起来的那段`）始终按等宽显示，不会退化成裸符号——包括整条消息只有行内代码的情况。

| 开关 | 默认 | 说明 |
|---|---|---|
| `forwardReasoning` | `false` | `/reasoning on` 后把思考内容也发出来（带 `🧠 思考` 前缀），排查问题时用 |
| `thinkingStatus` | `typing` | `typing`（只发状态）/ `message` / `off`（完全不发） |
| `format` | `markdown` | 消息发送格式：`markdown` 渲染标题/表格/代码块并自动转义保留字符（表格翻成键值行）；`plain` 原样输出。解析失败自动退回纯文本，不丢消息 |
| `notifyToolFailures` | `false` | 工具失败是否推到 Telegram。默认关：`ToolNotFoundError` / `WebError` 这类噪音只写日志，排查问题时才打开 |

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
  "version": "1.5.0",
  "state": "running",
  "pid": 3900,
  "startedAt": 1792418496591,
  "updatedAt": 1792418496591,
  "bot": "@your_bot",
  "botCommands": 44,
  "chats": 1,
  "boundSessions": 1,
  "approvalsEnabled": true,
  "questionsEnabled": true,
  "stats": { "updates": 12, "messages": 9, "errors": 0, "polls": 340, "pollErrors": 0, "timeouts": 0, "typingOk": 812, "typingFail": 0, "recentErrors": [] }
}
```

`state` 取值：`waiting-token`（等待配置）/ `running`（轮询中）/ `degraded`（轮询报错重试）/ `stopped`（已卸载或禁用）/ `disabled`。`updatedAt` 每 5 秒刷新——**它就是"插件是否活着"的心跳**。运行时还会带 `stats: { updates, messages, errors, lastUpdateAt, lastError, polls, pollErrors, timeouts, typingOk, typingFail, recentErrors }`：`lastError` 成功一次就清空（避免长期挂在 `degraded`），而 `pollErrors` / `timeouts` / `recentErrors` 是只增不减的计数器与最近 6 条错误环形缓冲，**成功之后证据仍然留着**，专供"手机端有时候没动静"这类偶发问题事后定位。`bot` 字段里的 token 只保留 `id:***末4位`。

## 命令

| 分类 | 命令 |
|---|---|
| 会话 | `/sessions`（按钮直接切换） `/new [目录] [\| 标题]` `/use <序号\|id\|标题>` `/watch <序号\|id\|标题>` `/unwatch <序号\|id\|标题\|all>` `/info` `/cancel` `/fork` `/rename <标题>` |
| 对话 | 直接发文本（下发 prompt，最终回答/回合状态回流）、`/models` `/model <provider> <model>` `/presets` |
| 直接控制 | `/shell <命令>` `/cd` `/pwd` `/ls [路径]` `/read <路径>` `/write <路径>⏎内容` `/tools` `/tool <名称> [JSON]` |
| 审批/提问 | `/approvals on\|off`（接管工具执行审批，内联按钮）、`/questions on\|off`（接管 `ask_user_question`）、`/reasoning on\|off` |
| 插件 | `/plugins` `/plugin enable\|disable <patchId>` `/bundles` `/install <包>` `/uninstall <名称>` |
| 主机 | `/power` `/shutdown [秒\|now]` `/reboot [秒\|now]` `/cancel` `/lock` `/sleep` `/hibernate` |
| 其它 | `/status` `/menu` `/pause` `/resume` `/myid` `/version` `/lang zh\|en` `/about` `/help` |

### 会话命名与切换

- **新建时就取名**：`/new 重构登录页` → 建好即调用 `rename`，标题写进会话投影。带目录再加 `|`：`/new F:\work\app | 重构登录页`。没有 `|` 时按内容判断——含路径分隔符或目录真实存在就当目录，否则当标题。
- **按标题切换**：`/use 重构登录页`（精确 → 不区分大小写），`/use 登录`（唯一命中时模糊匹配），`/use 3` `/use #3`（`/sessions` 的序号），`/use 9f3a12`（sessionId 前缀）。
- **点按钮切换**：`/sessions` 会附 12 个内联按钮（`s:<序号>`），点一下就绑定，并回一条「已绑定会话：标题」。
- **复制会话 ID**：`/sessions` 每个会话是「序号 + 标记 + 标题」一行、**完整 sessionId 单独占一行**（`session-133df74f-…`，无空格），长按那一行就能整段复制，粘到 `/use`、`/watch` 或 Web UI 都直接可用。
- **看标题**：`/info` 显示当前会话的标题/ID/目录/状态/事件数，`/status` 里也有「当前会话：标题 · id」，**这里的 id 同样是完整串**（不截断），可直接长按复制。
- 匹配到多个会话时不会瞎猜，直接把候选列出来让你用序号或更精确的标题重试；非 ID 形态的字符串（含中文）不会被当成 sessionId。

### 同时盯多个会话

一个聊天可以**同时订阅多个会话**（最多 5 个），输出全都回流到同一个 Telegram 会话里：

| 命令 | 作用 |
|---|---|
| `/use <序号\|id\|标题>` | 切换**主会话**——prompt、`/cancel`、`/fork`、`/rename` 都作用在它身上；其他已订阅会话不会被踢掉 |
| `/watch <序号\|id\|标题>` | 追加订阅一个会话（只看不发），推送时带 `🏷 标题` 前缀防串台；**订阅来的会话一律带标题**，哪怕只订阅了一个 |
| `/watch` | 列出当前订阅：`📌` 主会话、`👁` 旁听会话、`▶️` 正在干活 |
| `/unwatch <序号\|id\|标题>` | 取消某一条；若取消的正是主会话，自动回落到剩余的第一个 |
| `/unwatch all` | 全部取消（等价于恢复「一对一」模式） |

- 只有**主会话**接收 prompt，旁听会话纯输出；两个会话同时干活时，只要还有一个在跑，「正在输入…」就一直亮着。
- **通知带标题**：旁听会话的回答、思考转发、回合结束、工具失败、`Agent 错误`、工具执行审批、提问确认，开头都会带 `🏷 标题`（无标题时用完整 sessionId）；主会话只在同时盯了多个时才带，单会话不啰嗦。
- **订阅会话的审批/提问/错误也会推到手机**：以前只有主会话的事件能找到对应聊天，旁听会话的审批请求会被静默丢掉。
- 订阅关系写进状态文件（`watched` 数组），插件重载/DSH 重启后自动恢复，远程监控不会因为一次热重载断掉。
- `/sessions` 列表里 `📌` 是主会话、`👁` 是旁听会话，一眼看清哪些在盯。

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
- **安全开关**：`allowShell` / `allowTools` / `allowFs` 默认全开，白名单默认全拒——能力开关与身份白名单是两道独立的门，上线时都要过一眼。

## 快速参考（运维）

```text
# 查运行状态（state / errors / botCommands 心跳都在这）
cat %DSH_HOME%\telegram-control-status.json

# 配置页探活
curl http://127.0.0.1:59777/health

# 改配置即时生效（热加载，无需重启 DSH）
notepad %DSH_HOME%\telegram-control.json

# 彻底重置：两个文件删掉后重启 DSH，配置会重新生成模板、绑定清空
del %DSH_HOME%\telegram-control.json %DSH_HOME%\telegram-control-state.json
```

### 「一律未授权」怎么办

两个白名单都为空时所有消息都被拒绝（`/myid` 和 `/help` 除外）。给 Bot 发 `/myid` 拿到
`user_id` / `chat_id`，填进 `telegram-control.json` 的 `allowedUserIds` / `allowedChatIds`
任一个即可。`allowedUserIds` 与 `allowedChatIds` **同时非空时取交集**——只填两个 chat 也
必须把对应用户的 user_id 填进去，否则会被拒。

### 「正在输入…」亮着但没有回答

状态心跳 4 秒一续、最多撑 3 分钟无事件；若 `turn/end` 已到但仍无消息，看状态文件
`stats.lastError`，把 `notifyToolFailures` 打开收一轮工具失败推送，或 `/reasoning on`
直接看思考流定位卡点。

### 手机端（iOS/Android）有时候「没动静」，电脑端正常

先分清是**服务端没发**还是**手机端没收到**——发 `/status` 看新增的两行诊断：

```text
轮询：1234 次 · 失败 3（超时 3）· 打字：ok 987 / fail 0
最近错误（14:31:07）：getUpdates: 代理请求超时（40000ms）
```

- `打字：ok` 在涨、`失败`/`最近错误` 不涨 → 服务端一直在正常发包，问题在手机侧链路。
  手机若开了 Telegram 的 **webproxy / MTProxy**，消息要再穿一层代理才落到客户端，
  代理抖一下就是「电脑好的、手机不动」；换网络或用直连对比即可确认。
- `轮询：失败` / `超时` 在涨 → 是拉取侧被掐断。Bot API 前面挂了 **Cloudflare 反代**时最常见：
  长轮询是最容易被中间层丢弃的请求形态。把 `pollTimeoutSeconds` 压到 `15`，
  配合 600ms 快速重试（超时不再走 2/4/8…最多 30 秒的指数退避），空窗基本消失。
- `打字：fail` 在涨而 `轮询` 正常 → `sendChatAction` 被限流或中继拒绝，调大
  `thinkingStatus` 间隔或检查 `apiBaseUrl` 是否对 POST 做了限制。

## 测试

```text
npm test          # 等价于 node test/tg-control.test.mjs
```

本地起一个假的 Bot API（真 http server，走 `getUpdates` 长轮询）+ 假的 Cordis ctx / `sessionController` / `tools` / `pluginManager`，真跑插件：命令菜单注册、鉴权、命令分发、prompt 桥接、流式事件回流、**思考过程不上屏与 typing 节流**、语言切换、shell / 文件 / 工具直调、审批与提问内联按钮、会话命名与切换、电源控制（含二次确认与 `allowPower` 关闭）、配置页 CSRF 与保存、Markdown 渲染与纯文本兜底、热加载、卸载清理。

当前：**203 项断言全部通过**。测试用 `powerExec` 指向 `test/fixtures/fake-shutdown.mjs`，**绝不会真的关机**。

## 版本号约定

版本号只在**末尾追加第 4 段**，不动 major/minor/patch：

```text
1.4.0 → 1.4.0.1 → 1.4.0.2 → 1.4.0.3 → …
```

- 日常改动、修 bug、加小功能：跑 `npm run ver`（= `node scripts/bump-version.mjs`），末尾段 +1，四处版本号（`package.json` / `index.js` / 两个 README 的状态示例）一起改，自带一致性自检。
- 只有**明确要求升级版本**（例如「发 1.5」「打个大版本」）才用 `npm run ver -- --minor`（`1.4.0.6 → 1.5.0`）、`--major`、`--patch`，或 `--set 1.5.0` 直接指定。
- 想先看会改成什么：`npm run ver -- --dry`。
- 发版 tag 与版本号同名：`v1.4.0.1`。第 4 段能一直延伸下去，连续迭代不会把 minor 号一路冲高。

## 设计取舍

- 不声明 `inject`：所有服务在调用点用 `ctx.get()` 软解析，缺服务时命令给出可读错误而不是让整行插件失活。
- 不用 `Config` schema：避免引入 `@deepseek-ai/schemastery` 依赖，配置走热加载 JSON，改完无需重启。
- 不用长轮询以外的接入方式：Bot API `getUpdates` 不需要公网入口，本机即可运行。

## 注意事项

- **部署形态**：三平台兼容——电源命令按 `process.platform` 自动翻译：Windows `shutdown /s|/r /t <秒>`（`/a` 取消）、Linux/macOS `shutdown -h|-r now|+分钟`（Linux 可 `-c` 取消；**macOS 的 shutdown 没有取消命令**，定时任务发起后无法撤销）。锁屏三平台各自走 `rundll32` / `pmset displaysleepnow` / `loginctl lock-session`；睡眠 mac 用 `pmset sleepnow`、Linux 用 `systemctl suspend`。`/shell` Windows 依次试 `pwsh`→`powershell`→`cmd`，其余平台 `/bin/bash -lc`（想用 zsh 就给 `shellPath` 填 `/bin/zsh`）。
- **代理自动探测**：`proxyUrl: auto` 时 Windows 读注册表 WinINET，macOS 读 `scutil --proxy`，Linux 读 `http_proxy` 等 env 变量（其次 GNOME gsettings）；环境里都没有就直连——国内网络直连 `api.telegram.org` 大概率超时，此时显式给 `proxyUrl`。
- **密钥位置**：`botToken` 只存在 `%DSH_HOME%\telegram-control.json`（本地文件）与 DSH profile 配置里，不回显到日志与状态文件（状态里只保留 `id:***末4位`）。排查技巧：自查用 `grep -o '"botToken[^,]*'` 只取值，别整段贴出去。
- **配置页只监听本机**：`configPort` 绑定 `127.0.0.1`，局域网内其他设备访问不到；`/save` 有进程级 CSRF token 保护。端口改成 `0` 可彻底关掉配置页，用文件方式管理配置。
- **`/shell` `/write` `/tool` 等于把主机交出去**：白名单只认 Telegram 账号 id，账号被盗即主机裸奔。不确定时先把 `allowShell` / `allowPower` 关掉，按需再开。
- **并发语义**：同一 chat 的消息排队串行处理（每 chat 一条队列）；`/pause` 暂停命令分发但 prompt 下发与事件回流不受影响。
- **卸载**：`plugin_manager` 卸载或删除 `cordis.patch.yml` 行后重启 DSH，状态文件写成 `stopped`；`%DSH_HOME%` 下的三个 `telegram-control*.json` 需手动清理。

## 致谢 (Acknowledgements)

| 项目 | 在本项目里干什么活 |
|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | 本插件的上游宿主——Host 插件机制、sessionController / tools / pluginManager 全套 Host API 都来自它 |
| [cordis](https://github.com/cordiverse/cordis) | 「Everything is a Plugin」的内核：`apply(ctx, config)`、waterfall 事件、`ctx.effect` 生命周期 |

## 免责声明 (Disclaimer)

本项目仅供学习、研究与个人技术实验使用，请勿用于任何可能违反第三方服务条款（ToS）
或适用的法律法规的场景。

- 本项目与 DeepSeek、Telegram 等任何上游服务商均无关联、无背书（not affiliated
  with or endorsed by）。
- 本项目可远程执行 shell、读写文件、关闭主机——由使用者的白名单配置及其账号安全
  决定实际风险边界，由此产生的任何后果由使用者自行承担。
- Telegram Bot API 与 DeepSeek Harness 的可用性取决于上游策略，随时可能变化或失效
  （限流、改协议、下架均有可能），本项目不对其持续性、稳定性作任何担保。
- 本项目不收集、不存储任何用户数据；状态与配置全部落在本机 `%DSH_HOME%` 目录。
- 软件本体按 MIT 协议 "AS IS" 提供，不带任何担保（见 [LICENSE](./LICENSE)）。

## License

[MIT](./LICENSE) © 2026 [pingmike2](https://github.com/pingmike2)
