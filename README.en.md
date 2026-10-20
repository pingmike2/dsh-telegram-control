# dsh-telegram-control

English | **[简体中文](README.md)**

A **system-level** Telegram console for DSH: install it once and the whole DeepSeek Harness — every session, every preset — becomes remotely controllable from a Telegram bot.

- Pure Host plugin, zero third-party dependencies (Node built-ins only). Installs and works immediately, no `pnpm` install needed.
- Mounted once: a process-level singleton that does not follow agent presets, so every session shares the same bot.
- It thinks, but does not spam: **reasoning never reaches the screen by default**. Telegram only shows the “typing…” status, then the final answer.

> ⚠️ This plugin can run commands, power off the host and write files. Configure the `allowedUserIds` / `allowedChatIds` allowlists before going live, and turn off what you do not need via `allowShell` / `allowTools` / `allowFs` / `allowPower`.

## Install

```text
plugin_manager install_bundle  target = <absolute path to this directory>
```

Installation inserts a `telegram-control` row at the front of the profile's `cordis.patch.yml`.

## Go live (no DSH restart required)

**GUI way**: once started, the plugin serves a local config page — <http://127.0.0.1:59777/>

Fill in `botToken`, `allowedUserIds` / `allowedChatIds`, proxy and toggles (including language and thinking status), then hit “save and apply”. Polling starts within 5 seconds. `GET /status` returns the runtime snapshot as JSON for scripted health checks; `/health` returns `{"ok":true}`.

**File way**: edit `%DSH_HOME%\telegram-control.json` (default `C:\Users\<you>\.dsh\telegram-control.json`). A template is generated on first run and the file **hot-reloads every 5 seconds**.

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
  "notifyToolFailures": false
}
```

1. Get a token from @BotFather and put it in `botToken`.
2. Send `/myid` to your bot and copy the `user_id` / `chat_id` into the allowlists — **when both allowlists are empty every message is rejected**, except `/myid` and `/help` (which exist exactly so you can bootstrap).
3. Save. Polling starts within 5 seconds; changing the token restarts polling gracefully, while allowlist and toggle changes apply in place.

## Command menu (type `/` to get suggestions)

On startup the plugin calls `setMyCommands` and registers **41 commands** across **default / private chats / group chats**, and sets the menu button to `commands`. Typing `/` therefore opens a suggestions list with descriptions (localized).

- If registration failed or the client cached an old list: send `/menu` (alias `/commands`) to re-register, then switch away from the chat and back.
- It also sets the bot's short description and description (`setMyShortDescription` / `setMyDescription`) so the profile page explains what it does.
- `botCommands` in the status file is the registered count; `GET /status` exposes the same value.

## Thinking and status feedback

While the model reasons it emits a flood of `reasoning` deltas. Those **never reach the chat** (the Web UI uses them; Telegram does not need them). The plugin does exactly two things:

1. Sends `sendChatAction: typing` — the familiar “typing…” indicator. **As long as the turn is running the heartbeat renews it every 4 seconds**, so even ten minutes of tool calls keeps it lit and a remote glance tells you DSH is still working; it stops at `turn/end`, and after 3 minutes without any session event it also shuts itself off.
2. Sends the `text` block of the final `assistant/message` as the answer.

**Tool calls stay off screen as well**: `tool/call` (the `🔧 edit` / `🔧 pwsh` kind) only refreshes the typing indicator and sends no message at all; `tool/result` **failures are not forwarded by default** either — `ToolNotFoundError` / `WebError` and friends are intermediate states the agent retries or works around, so they go to the log instead of your phone. Turn on `notifyToolFailures` when you are debugging and you get a single `⚠️ Tool failed: …` line. On your phone you therefore always see: status moving → final answer.

Replies are rendered as Markdown: headings become bold, fenced code lands in monospace blocks, and reserved characters such as `*` `_` `.` are escaped instead of leaking into the chat as raw source. Tables have no MarkdownV2 syntax and monospace blocks wrap badly on a phone, so they are **turned into key/value lines**: two columns become `• label: value`, wider tables become `• header: value · header: value`. If Telegram ever rejects a message, it is resent as plain text.

| Toggle | Default | Meaning |
|---|---|---|
| `forwardReasoning` | `false` | After `/reasoning on`, reasoning is also forwarded (prefixed with `🧠 Thinking`) — useful when debugging |
| `thinkingStatus` | `typing` | `typing` (status only) / `message` / `off` (nothing at all) |
| `format` | `markdown` | Outbound format: `markdown` renders headings / tables / code blocks and escapes reserved characters (tables become key/value lines); `plain` sends the source verbatim. Unparseable messages are resent as plain text, never dropped |
| `notifyToolFailures` | `false` | Whether tool failures reach Telegram. Off by default: `ToolNotFoundError` / `WebError` noise stays in the log; turn it on while debugging |

## Networking and proxy

Node's `fetch` (undici) **does not honor the Windows system proxy**, so on networks that need a proxy to reach `api.telegram.org` you get `UND_ERR_CONNECT_TIMEOUT` — visible as a `degraded` status file with `errors` climbing.

`proxyUrl` accepts three forms:

| Value | Behavior |
|---|---|
| `auto` (default) | Reads `ProxyServer` from `HKCU\...\Internet Settings` and applies it (e.g. `http://127.0.0.1:10808`) |
| `http://host:port` | Explicit HTTP proxy |
| `none` | Force a direct connection (tests, or intranet relaying) |

With a proxy, the plugin issues an HTTP `CONNECT` via `node:http` and then speaks HTTP/1.1 through the tunnel by hand (TLS layered on with `node:tls`) — still zero dependencies, and config changes apply without restarting Harness.

## Runtime status (verifiable without Telegram)

Every supervision tick rewrites `%DSH_HOME%\telegram-control-status.json`:

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

`state` is one of `waiting-token` (waiting for config) / `running` (polling) / `degraded` (errors, retrying) / `stopped` (uninstalled or disabled) / `disabled`. `updatedAt` refreshes every 5 seconds — **it is the “is the plugin alive” heartbeat**. At runtime it also carries `stats: { updates, messages, errors, lastUpdateAt, lastError }`, and the token inside `bot` is masked to `id:***last4`.

## Commands

| Group | Commands |
|---|---|
| Sessions | `/sessions` (tap to switch) `/new [dir] [\| title]` `/use <index\|id\|title>` `/info` `/cancel` `/fork` `/rename <title>` |
| Chat | Send plain text (becomes a prompt; final answer and turn status stream back), `/models` `/model <provider> <model>` `/presets` |
| Direct control | `/shell <command>` `/cd` `/pwd` `/ls [path]` `/read <path>` `/write <path>⏎content` `/tools` `/tool <name> [JSON]` |
| Approvals & questions | `/approvals on\|off` (take over tool approvals with inline buttons), `/questions on\|off` (take over `ask_user_question`), `/reasoning on\|off` |
| Plugins | `/plugins` `/plugin enable\|disable <patchId>` `/bundles` `/install <name\|path>` `/uninstall <name>` |
| Host | `/power` `/shutdown [seconds\|now]` `/reboot [seconds\|now]` `/cancel` `/lock` `/sleep` `/hibernate` |
| Misc | `/status` `/menu` `/pause` `/resume` `/myid` `/version` `/lang zh\|en` `/help` |

### Naming and switching sessions

- **Name it while creating it**: `/new Refactor login page` → the session is created and `rename` is called immediately, so the title lands in the session projection. Add a directory with `|`: `/new F:\work\app | Refactor login page`. Without `|`, the argument is classified by content — contains a path separator or points at an existing directory → directory, otherwise → title.
- **Switch by title**: `/use Refactor login page` (exact, case-insensitive), `/use login` (fuzzy match when unambiguous), `/use 3` `/use #3` (index from `/sessions`), `/use 9f3a12` (sessionId prefix).
- **Switch by button**: `/sessions` attaches up to 12 inline buttons (`s:<index>`); one tap binds the session and replies “bound session: title”.
- **See the title**: `/info` shows the bound session's title/ID/cwd/state/event count, and `/status` includes “bound session: title · id”.
- Ambiguous matches are never guessed: the plugin lists candidates so you can retry with an index or a more precise title; strings that are not ID-shaped (including Chinese text) are never treated as a sessionId.

### Host power control (shutdown / reboot / lock)

Carried over from the previous bot: one command shuts the machine down remotely.

| Command | Effect |
|---|---|
| `/power` | Host and power status: hostname, platform, process uptime, memory, CPU count, whether allowed, scheduled job, last action |
| `/shutdown` | Shut down after 60 seconds (configurable via `powerDefaultSeconds`) |
| `/shutdown 300` | Shut down after 300 seconds (max 86400) |
| `/shutdown now` | Shut down immediately — **requires confirming an inline button** to prevent accidents |
| `/reboot` `/restart` | Same forms: no argument / seconds / `now` |
| `/shutdown cancel` | Abort a scheduled shutdown or reboot (same as `shutdown /a`) |
| `/cancel` | Cancel the current turn, and **also abort** any scheduled shutdown (kept for muscle memory) |
| `/lock` | Lock the screen (`rundll32 user32.dll,LockWorkStation`) |
| `/sleep` `/hibernate` | Suspend / hibernate (hibernate requires it to be enabled in the OS) |

Safety design:

- `allowPower` toggle (switchable off on the config page); when off, every power command is refused outright.
- **Shutdown/reboot within ≤10 seconds must be confirmed by a button**: `p:<token>:1` executes, `p:<token>:0` cancels, and the token is single-use.
- The default 60-second countdown leaves a window to change your mind; `/cancel` aborts instantly.
- Exit codes are translated: `1190` (already scheduled), `1116` (nothing scheduled), `5` (access denied), `1` (invalid argument).
- `powerExec` can replace the `shutdown` binary itself (point it at a custom executable; for `.js/.mjs/.cjs` it runs under the current Node). The test suite relies on this to inject a fake implementation — it can never really power off.
- On non-Windows platforms it falls back to `systemctl poweroff/reboot`, `pmset sleepnow`, `loginctl lock-session`.

## Implementation notes

- **Session bridge**: `ctx.get('sessionController')` → `create / prompt / follow / cancel / fork / rename / selectModel`, the same Host API the Web UI uses; the `follow` stream is deduplicated by seq and only forwards events after binding.
- **Approval takeover**: registers the `approval/request` waterfall, pushes the request to Telegram and waits for an inline button; timeouts resolve as `cancelled` (fail-closed); when no session is bound or takeover is off it calls `next()` untouched, so the Web UI keeps working. **The toggle is persisted**, so hot reload never resets it.
- **Question takeover**: registers the `user-questions/request` waterfall; a single question maps to buttons plus free-text replies; timeouts are handed back to Harness.
- **Direct tool calls**: `ctx.get('tools').execute({ callId, name, arguments, agent, signal })` with a timeout AbortSignal.
- **Shell**: `node:child_process` spawned directly (on Windows it tries `pwsh` → `powershell` → `cmd`), output capped at 200KB, timeout configurable.
- **State persistence**: chat → session bindings are written to `%DSH_HOME%\telegram-control-state.json` (800ms debounce).
- **Safety switches**: `allowShell` / `allowTools` / `allowFs` / allowlists; by default everything requires an explicitly authorized user.

## Tests

```text
npm test          # same as node test/tg-control.test.mjs
```

A fake Bot API (a real http server speaking `getUpdates` long-polling) plus fake Cordis ctx / `sessionController` / `tools` / `pluginManager` run the real plugin end to end: command-menu registration, auth, command dispatch, prompt bridging, streaming event relay, **reasoning kept off screen with a continuous typing heartbeat**, language switching, shell / file / direct tool calls, approval and question inline buttons, session naming and switching, power control (including the confirmation flow and `allowPower` off), config-page CSRF and saving, Markdown rendering with the plain-text fallback, hot reload, and uninstall cleanup.

Currently **all 141 assertions pass**. The suite points `powerExec` at `test/fixtures/fake-shutdown.mjs`, so **it can never really power off the machine**.

## Design trade-offs

- No `inject` declaration: every service is soft-resolved with `ctx.get()` at the call site, so a missing service yields a readable command error instead of disabling the whole plugin row.
- No `Config` schema: avoids depending on `@deepseek-ai/schemastery`; config is a hot-reloaded JSON file you can edit without restarting.
- No transport other than long polling: Bot API `getUpdates` needs no public ingress, so it runs on a laptop.

## License

MIT
