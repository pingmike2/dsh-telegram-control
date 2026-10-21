# dsh-telegram-control

English | **[简体中文](README.md)** · Author [pingmike2](https://github.com/pingmike2) · Repo [pingmike2/dsh-telegram-control](https://github.com/pingmike2/dsh-telegram-control)

A **system-level** Telegram console for DSH: install it once and the whole DeepSeek Harness — every session, every preset — becomes remotely controllable from a Telegram bot.

- Pure Host plugin, zero third-party dependencies (Node built-ins only). Installs and works immediately, no `pnpm` install needed.
- Mounted once: a process-level singleton that does not follow agent presets, so every session shares the same bot.
- It thinks, but does not spam: **reasoning never reaches the screen by default**. Telegram only shows the “typing…” status, then the final answer.

> ⚠️ This plugin can run commands, power off the host and write files. Configure the `allowedUserIds` / `allowedChatIds` allowlists before going live, and turn off what you do not need via `allowShell` / `allowTools` / `allowFs` / `allowPower`.

## Architecture

```text
Telegram mobile client
  │  slash commands, text prompts, inline-button callbacks
  ▼
getUpdates long polling (proxyUrl: auto = read Windows system proxy / explicit http:// / none = direct)
  ▼
telegram-control (Host plugin, process-level singleton)
  ├─ allowlist check (allowedUserIds / allowedChatIds — both set = intersection)
  ├─ command dispatch (41 commands: sessions / chat / shell / files / approvals / plugins / power / i18n)
  ├─ sessionController (Host API: create / prompt / follow / cancel / fork / rename / selectModel)
  │    └─ follow stream dedup by seq → assistant answers stream back to Telegram; reasoning stays off-screen, only a typing heartbeat
  ├─ approval/request & user-questions/request waterfalls → inline-button takeover (timeout fail-closed / handed back to Harness)
  └─ local config page http://127.0.0.1:59777/ (CSRF-protected; GET /config /status /health, POST /save)
       └─ edits telegram-control.json → hot-reloaded every reloadSeconds (default 5s), no DSH restart

State on disk: %DSH_HOME%\telegram-control-state.json (chat↔session bindings)
               %DSH_HOME%\telegram-control-status.json (runtime snapshot, see “Runtime status”)
```

## Install

Two ways, pick one:

**A. Clone the repo** (easier updates: just `git pull`):

```text
git clone https://github.com/pingmike2/dsh-telegram-control.git
plugin_manager install_bundle  target = <absolute path to the cloned directory>
```

**B. Download the release package** (no git required; the zip opens with a double-click on Windows):

```text
1. Grab dsh-telegram-control-<version>.zip from https://github.com/pingmike2/dsh-telegram-control/releases/latest
2. Unzip it anywhere
3. plugin_manager install_bundle  target = <absolute path to the unzipped directory>
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

### Full configuration reference (real names + real defaults, as read by the code)

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; `false` stops polling, status shows `disabled` |
| `lang` | `zh` | UI language, any code present in `locale/*.json` (currently `en` / `zh`); invalid values fall back to `zh` |
| `botToken` | empty | Token from @BotFather; while empty the plugin stays in `waiting-token` |
| `apiBaseUrl` | `https://api.telegram.org` | Bot API base URL (point at a third-party relay if needed) |
| `proxyUrl` | `auto` | `auto`=read Windows system proxy; explicit `http://host:port`; `none`/`off`/`direct`=force direct |
| `configPort` | `59777` | Local config page port, `0`=disabled; binds to `127.0.0.1` only |
| `allowedUserIds` / `allowedChatIds` | empty | Allowlists; when both are set they intersect, numbers only |
| `workingDirectory` | empty | Default working directory; empty = DSH default |
| `agentPreset` | empty | Agent preset for new sessions; empty = `standard` |
| `pollTimeoutSeconds` | `25` | `getUpdates` long-poll duration (1–50); use `15` behind a Cloudflare reverse proxy |
| `maxMessageChars` | `3600` | Per-message cap (200–4096); longer output is split into chunks |
| `answerApprovals` | `false` | Take over tool approvals → inline buttons; timeout counts as rejection |
| `answerQuestions` | `false` | Take over `ask_user_question` → buttons / free-text replies |
| `forwardReasoning` | `false` | After `/reasoning on`, reasoning content is pushed to Telegram |
| `thinkingStatus` | `typing` | `typing` / `message` / `off` |
| `format` | `markdown` | `markdown` (MarkdownV2 with plain-text fallback) / `plain` |
| `notifyToolFailures` | `false` | Whether tool failures are pushed to Telegram |
| `approvalTimeoutSeconds` | `120` | How long approval buttons wait (10–3600) |
| `commandTimeoutSeconds` | `120` | Timeout for `/shell` and `/tool` (1–3600) |
| `allowShell` / `allowTools` / `allowFs` / `allowPower` | `true` | Four capability switches |
| `powerDefaultSeconds` | `60` | Countdown when `/shutdown` has no argument (0–86400) |
| `powerExec` | empty | Custom shutdown binary path; `.js/.mjs/.cjs` runs under the current Node (used by tests) |
| `shellPath` | empty | Custom shell; empty = try `pwsh`→`powershell`→`cmd` on Windows, `/bin/bash -lc` elsewhere |
| `reloadSeconds` | `5` | Config hot-reload interval (2–600) |

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
  "version": "1.4.1.3",
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

`state` is one of `waiting-token` (waiting for config) / `running` (polling) / `degraded` (errors, retrying) / `stopped` (uninstalled or disabled) / `disabled`. `updatedAt` refreshes every 5 seconds — **it is the “is the plugin alive” heartbeat**. At runtime it also carries `stats: { updates, messages, errors, lastUpdateAt, lastError, polls, pollErrors, timeouts, typingOk, typingFail, recentErrors }`: `lastError` is cleared as soon as one poll succeeds (so the state no longer sticks at `degraded`), while `pollErrors` / `timeouts` / `recentErrors` are monotonic counters plus a ring buffer of the last six errors — **the evidence survives recovery**, which is what makes intermittent “the phone went silent” reports diagnosable after the fact. The token inside `bot` is masked to `id:***last4`.

## Commands

| Group | Commands |
|---|---|
| Sessions | `/sessions` (tap to switch) `/new [dir] [\| title]` `/use <index\|id\|title>` `/info` `/cancel` `/fork` `/rename <title>` |
| Chat | Send plain text (becomes a prompt; final answer and turn status stream back), `/models` `/model <provider> <model>` `/presets` |
| Direct control | `/shell <command>` `/cd` `/pwd` `/ls [path]` `/read <path>` `/write <path>⏎content` `/tools` `/tool <name> [JSON]` |
| Approvals & questions | `/approvals on\|off` (take over tool approvals with inline buttons), `/questions on\|off` (take over `ask_user_question`), `/reasoning on\|off` |
| Plugins | `/plugins` `/plugin enable\|disable <patchId>` `/bundles` `/install <name\|path>` `/uninstall <name>` |
| Host | `/power` `/shutdown [seconds\|now]` `/reboot [seconds\|now]` `/cancel` `/lock` `/sleep` `/hibernate` |
| Misc | `/status` `/menu` `/pause` `/resume` `/myid` `/version` `/lang zh\|en` `/about` `/help` |

### Naming and switching sessions

- **Name it while creating it**: `/new Refactor login page` → the session is created and `rename` is called immediately, so the title lands in the session projection. Add a directory with `|`: `/new F:\work\app | Refactor login page`. Without `|`, the argument is classified by content — contains a path separator or points at an existing directory → directory, otherwise → title.
- **Switch by title**: `/use Refactor login page` (exact, case-insensitive), `/use login` (fuzzy match when unambiguous), `/use 3` `/use #3` (index from `/sessions`), `/use 9f3a12` (sessionId prefix).
- **Switch by button**: `/sessions` attaches up to 12 inline buttons (`s:<index>`); one tap binds the session and replies “bound session: title”.
- **Copy a session ID**: in `/sessions`, each entry is one line of “index + marks + title” followed by the **full sessionId on its own line** (`session-133df74f-…`, no spaces) — long-press that line to copy the whole thing into `/use`, `/watch`, or the Web UI. `/info` and `/status` print the same **untruncated** id.

### Watching several sessions at once

One chat can **watch several sessions simultaneously** (up to 5); all their output streams into the same Telegram chat:

| Command | Effect |
|---|---|
| `/use <index\|id\|title>` | Switches the **primary** session — prompts, `/cancel`, `/fork`, `/rename` target it; already-watched sessions stay subscribed |
| `/watch <index\|id\|title>` | Subscribes one more session (read-only); pushed messages carry a `🏷 title` prefix so they never blur together — **watched sessions always carry the title**, even if only one is watched |
| `/watch` | Lists subscriptions: `📌` primary, `👁` watched, `▶️` currently working |
| `/unwatch <index\|id\|title>` | Drops one; if it was the primary, the first remaining session takes over automatically |
| `/unwatch all` | Drops everything (back to strict one-to-one mode) |

- Only the **primary** session receives prompts; watched sessions are output-only. When two run at once, the “typing…” heartbeat stays on as long as at least one is working.
- **Notifications carry the title**: answers, forwarded reasoning, turn end, tool failures, `Agent error`, tool approvals and question prompts from a watched session all start with `🏷 title` (falling back to the full sessionId when untitled); the primary session only adds it when several sessions are watched, so single-session chats stay clean.
- **Approvals, questions and errors from watched sessions reach Telegram too**: previously only events of the primary session could be mapped back to a chat, so a watched session's approval request was silently dropped.
- Subscriptions persist in the state file (a `watched` array), so they survive plugin reloads and DSH restarts — remote monitoring does not drop on a hot reload.
- In `/sessions`, `📌` marks the primary and `👁` marks watched sessions.
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
- **Safety switches**: `allowShell` / `allowTools` / `allowFs` default to **on**, the allowlists default to **deny all** — capability switches and the identity allowlist are two separate gates, check both before going live.

## Ops quick reference

```text
# Runtime status (state / errors / botCommands heartbeat)
cat %DSH_HOME%\telegram-control-status.json

# Config page health probe
curl http://127.0.0.1:59777/health

# Change config on the spot (hot reload, no DSH restart)
notepad %DSH_HOME%\telegram-control.json

# Full reset: delete both files, restart DSH — config re-templates, bindings cleared
del %DSH_HOME%\telegram-control.json %DSH_HOME%\telegram-control-state.json
```

### “Everything says unauthorized”

With both allowlists empty every message is rejected (`/myid` and `/help` excepted).
Send `/myid` to get your `user_id` / `chat_id`, then put either of them in
`allowedUserIds` / `allowedChatIds`. When **both lists are non-empty they intersect** —
listing your chats but not your `user_id` still gets you rejected.

### “Typing…” keeps showing but no answer arrives

The heartbeat renews every 4s and gives up after 3 minutes without events; if
`turn/end` has passed with no message, check `stats.lastError` in the status file,
turn on `notifyToolFailures` for one round of tool-failure pushes, or use
`/reasoning on` to watch the reasoning stream and find the hang.

### The phone goes silent while desktop is fine

First tell apart *server did not send* from *phone did not receive* — send `/status`
and read the two new diagnostic lines:

```text
Polling: 1234 calls · 3 failures (3 timeouts) · typing: ok 987 / fail 0
Last error (14:31:07): getUpdates: proxy request timed out (40000ms)
```

- `typing: ok` climbing while `failures` / `Last error` stay flat → the server keeps
  sending; the problem is on the phone's link. If the phone has a Telegram
  **webproxy / MTProxy** enabled, messages must traverse one more hop, and one hiccup
  there looks exactly like “desktop fine, phone frozen”. Switch networks or use a
  direct connection to confirm.
- `failures` / `timeouts` climbing → the fetch side is being cut. The usual cause is a
  **Cloudflare reverse proxy** in front of the Bot API: a long poll is the request shape
  intermediaries drop most eagerly. Set `pollTimeoutSeconds` to `15`; together with the
  600ms fast retry (timeouts no longer walk the 2/4/8… 30s exponential backoff) the dead
  windows effectively disappear.
- `typing: fail` climbing while polling is fine → `sendChatAction` is rate-limited or
  rejected by the relay; widen the `thinkingStatus` interval or check whether
  `apiBaseUrl` restricts POST.

## Tests

```text
npm test          # same as node test/tg-control.test.mjs
```

A fake Bot API (a real http server speaking `getUpdates` long-polling) plus fake Cordis ctx / `sessionController` / `tools` / `pluginManager` run the real plugin end to end: command-menu registration, auth, command dispatch, prompt bridging, streaming event relay, **reasoning kept off screen with a continuous typing heartbeat**, language switching, shell / file / direct tool calls, approval and question inline buttons, session naming and switching, power control (including the confirmation flow and `allowPower` off), config-page CSRF and saving, Markdown rendering with the plain-text fallback, hot reload, and uninstall cleanup.

Currently **all 195 assertions pass**. The suite points `powerExec` at `test/fixtures/fake-shutdown.mjs`, so **it can never really power off the machine**.

## Versioning convention

Releases only ever extend the **fourth segment**; major/minor/patch stay put:

```text
1.4.0 → 1.4.0.1 → 1.4.0.2 → 1.4.0.3 → …
```

- Everyday work, bug fixes, small features: run `npm run ver` (= `node scripts/bump-version.mjs`). It increments the last segment and rewrites all four version spots (`package.json`, `index.js`, both README status samples), then self-checks that they agree.
- Only when a version bump is **explicitly requested** (“ship 1.5”, “cut a major”) use `npm run ver -- --minor` (`1.4.0.6 → 1.5.0`), `--major`, `--patch`, or `--set 1.5.0`.
- Preview first: `npm run ver -- --dry`.
- The release tag mirrors the version: `v1.4.0.1`. The fourth segment can keep extending, so steady iteration never races the minor number upward.

## Design trade-offs

- No `inject` declaration: every service is soft-resolved with `ctx.get()` at the call site, so a missing service yields a readable command error instead of disabling the whole plugin row.
- No `Config` schema: avoids depending on `@deepseek-ai/schemastery`; config is a hot-reloaded JSON file you can edit without restarting.
- No transport other than long polling: Bot API `getUpdates` needs no public ingress, so it runs on a laptop.

## Notes

- **Deployment shape**: cross-platform — power commands are translated per `process.platform`: Windows `shutdown /s|/r /t <seconds>` (cancel `/a`), Linux/macOS `shutdown -h|-r now|+minutes` (Linux can cancel with `-c`; **macOS shutdown has no cancel command**, a scheduled action cannot be revoked). Lock walks `rundll32` / `pmset displaysleepnow` / `loginctl lock-session`; sleep uses `pmset sleepnow` on macOS and `systemctl suspend` on Linux. `/shell` tries `pwsh`→`powershell`→`cmd` on Windows, `/bin/bash -lc` elsewhere (set `shellPath` to `/bin/zsh` if you prefer zsh).
- **Automatic proxy detection**: with `proxyUrl: auto`, Windows reads the WinINET registry, macOS reads `scutil --proxy`, Linux reads the `http_proxy` / `https_proxy` / `all_proxy` env vars (then GNOME gsettings). If none are present it goes direct — from networks where `api.telegram.org` is unreachable directly, set `proxyUrl` explicitly.
- **Secret location**: `botToken` lives only in `%DSH_HOME%\telegram-control.json` (a local file) and the DSH profile config; it is never echoed into logs or the status file (which keeps only the `id:***last4` form). For a local check use something like `grep -o '"botToken[^,]*'` to grab just the value — don’t paste the whole line around.
- **Config page is local-only**: `configPort` binds to `127.0.0.1`, unreachable from other machines on the LAN; `POST /save` is guarded by a process-level CSRF token. Setting the port to `0` shuts the page down completely and you manage config by file.
- **`/shell`, `/write`, `/tool` hand over the host**: the allowlist only knows Telegram account ids — a stolen account means a bare host. If unsure, switch `allowShell` / `allowPower` off first and re-enable on demand.
- **Concurrency semantics**: messages from the same chat are processed sequentially (one queue per chat); `/pause` stops command dispatch but prompt delivery and event streaming keep flowing.
- **Uninstall**: after `plugin_manager` removal (or deleting the `cordis.patch.yml` row) and a DSH restart, the status file flips to `stopped`; the three `telegram-control*.json` files under `%DSH_HOME%` must be cleaned up manually.

## Acknowledgements

| Project | What it does here |
|---|---|
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | The upstream host — the Host-plugin mechanism and the whole `sessionController` / `tools` / `pluginManager` Host API come from it |
| [cordis](https://github.com/cordiverse/cordis) | The "Everything is a Plugin" kernel: `apply(ctx, config)`, waterfall events, `ctx.effect` lifecycle |

## Disclaimer

This project is for learning, research and personal technical experiments only. Do not
use it in any way that may violate third-party terms of service (ToS) or applicable
laws and regulations.

- This project is not affiliated with or endorsed by DeepSeek, Telegram or any other
  upstream provider.
- This project can execute shell commands, read and write files and power the host off —
  the actual risk boundary is decided by the user’s allowlist configuration and account
  security, and any resulting consequences are borne by the user.
- Availability of the Telegram Bot API and DeepSeek Harness depends entirely on upstream
  policies and may change or break at any time (rate limits, protocol changes, removal);
  no guarantee of continuity or stability is given.
- This project collects and stores no user data; state and config stay entirely in the
  local `%DSH_HOME%` directory.
- The software itself is provided "AS IS" under the MIT license, without any warranty
  (see [LICENSE](./LICENSE)).

## License

[MIT](./LICENSE) © 2026 [pingmike2](https://github.com/pingmike2)
