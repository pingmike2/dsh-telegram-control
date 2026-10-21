/**
 * dsh-telegram-control 离线端到端测试。
 *
 * 用本地 http 假 Telegram API + 假 Cordis ctx / 服务，真跑插件的：
 * 轮询与命令菜单、鉴权、命令分发、prompt 桥接、流式事件回流、
 * 思考过程不打扰、i18n、shell / 文件 / 工具、审批与提问接管、
 * 会话命名与切换、电源控制、配置页、热加载、卸载。
 *
 * 运行：node test/tg-control.test.mjs
 */

import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const startedAt = Date.now()
let passed = 0
const failed = []

function ok(condition, label, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✔ ${label} (+${Date.now() - startedAt}ms)`)
    return
  }
  failed.push(label)
  console.log(`  ❌ ${label}${detail ? `\n      ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value = false
    try {
      value = await predicate()
    } catch {
      value = false
    }
    if (value) {
      passed += 1
      console.log(`  ✔ ${label} (+${Date.now() - startedAt}ms)`)
      return true
    }
    if (Date.now() >= deadline) break
    await sleep(40)
  }
  failed.push(label)
  console.log(`  ❌ ${label}（超时 ${timeoutMs}ms）`)
  return false
}

function section(title) {
  console.log(`\n▶ ${title}`)
}

// ───────────────────────── 假 Telegram Bot API ─────────────────────────

const api = {
  updates: [],
  calls: [],
  messages: [],
  edits: [],
  markdownMessages: [],
  rejectMarkdown: false,
  failGetUpdates: false,
  nextUpdateId: 1,
  nextMessageId: 1,
  botUsername: 'dsh_test_bot',
}

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let body = {}
    try {
      body = raw.length > 0 ? JSON.parse(raw) : {}
    } catch {
      body = {}
    }
    const method = String(req.url ?? '').split('/').pop()
    api.calls.push({ method, body })

    const reply = (result) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, result }))
    }

    if (method === 'getMe') {
      return reply({ id: 1234, is_bot: true, first_name: 'DSH Test', username: api.botUsername })
    }
    if (method === 'getUpdates') {
      if (api.failGetUpdates) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error_code: 500, description: 'Internal Server Error' }))
        return
      }
      const offset = Number(body.offset ?? 0)
      const budget = Math.min(Number(body.timeout ?? 0) || 0, 1) * 1000
      const deadline = Date.now() + budget
      for (;;) {
        const ready = api.updates.filter((update) => Number(update.update_id) >= offset)
        if (ready.length > 0) {
          api.updates = api.updates.filter((update) => Number(update.update_id) < offset)
          return reply(ready)
        }
        if (Date.now() >= deadline) return reply([])
        await sleep(30)
      }
    }
    if (method === 'sendMessage') {
      if (body.parse_mode && api.rejectMarkdown) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities: unexpected end of the entity" }))
        return
      }
      const message = {
        message_id: api.nextMessageId,
        chat_id: Number(body.chat_id),
        text: String(body.text ?? ''),
        reply_markup: body.reply_markup,
        parse_mode: body.parse_mode,
      }
      api.nextMessageId += 1
      api.messages.push(message)
      if (body.parse_mode) api.markdownMessages.push(message)
      return reply({ message_id: message.message_id, chat: { id: message.chat_id }, text: message.text })
    }
    if (method === 'editMessageText') {
      api.edits.push({ chat_id: Number(body.chat_id), text: String(body.text ?? '') })
      return reply(true)
    }
    return reply(true)
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const apiBaseUrl = `http://127.0.0.1:${server.address().port}`

// ───────────────────────── 假 DSH 环境 ─────────────────────────

const home = await mkdtemp(join(tmpdir(), 'dsh-tg-ctl-'))
process.env.DSH_HOME = home
const workDir = join(home, 'work')
const backendDir = join(home, 'backend')
await mkdir(workDir, { recursive: true })
await mkdir(backendDir, { recursive: true })

const configPath = join(home, 'telegram-control.json')
const statusPath = join(home, 'telegram-control-status.json')
const statePath = join(home, 'telegram-control-state.json')
const powerLog = join(home, 'power-calls.log')
const notePath = join(workDir, 'note.txt')
const fixture = fileURLToPath(new URL('./fixtures/fake-shutdown.mjs', import.meta.url))

process.env.FAKE_SHUTDOWN_LOG = powerLog

const CHAT_ID = 1001
const USER_ID = 123456789
const configPort = 59000 + Math.floor(Math.random() * 400)

const baseConfig = {
  enabled: true,
  lang: 'zh',
  botToken: '1234:TEST-TOKEN',
  apiBaseUrl,
  proxyUrl: 'none',
  configPort,
  allowedUserIds: [USER_ID],
  allowedChatIds: [CHAT_ID],
  workingDirectory: workDir,
  agentPreset: '',
  pollTimeoutSeconds: 1,
  maxMessageChars: 3600,
  answerApprovals: false,
  answerQuestions: false,
  forwardReasoning: false,
  thinkingStatus: 'typing',
  // 绝大多数断言直接比对字面文本，所以先跑纯文本；Markdown 渲染单独测。
  format: 'plain',
  approvalTimeoutSeconds: 120,
  commandTimeoutSeconds: 60,
  allowShell: true,
  allowTools: true,
  allowFs: true,
  allowPower: true,
  powerDefaultSeconds: 60,
  powerExec: fixture,
  shellPath: '',
  reloadSeconds: 2,
}
await writeFile(configPath, `${JSON.stringify(baseConfig, null, 2)}\n`, 'utf8')

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function patchConfig(patch) {
  const current = (await readJson(configPath)) ?? {}
  await writeFile(configPath, `${JSON.stringify({ ...current, ...patch, updatedAt: Date.now() }, null, 2)}\n`, 'utf8')
}

function pushUpdate(update) {
  api.updates.push({ update_id: api.nextUpdateId, ...update })
  api.nextUpdateId += 1
}

function pushText(text, { chatId = CHAT_ID, userId = USER_ID } = {}) {
  pushUpdate({
    message: {
      message_id: api.nextMessageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' },
      from: { id: userId, is_bot: false, first_name: 'YG', language_code: 'zh-hans' },
      text,
    },
  })
  api.nextMessageId += 1
}

function pushCallback(data, { chatId = CHAT_ID, userId = USER_ID } = {}) {
  pushUpdate({
    callback_query: {
      id: `cb-${api.nextUpdateId}`,
      from: { id: userId, is_bot: false, first_name: 'YG' },
      data,
      message: { message_id: api.nextMessageId, chat: { id: chatId, type: 'private' } },
    },
  })
}

const chatMessages = (chatId = CHAT_ID) => api.messages.filter((message) => message.chat_id === chatId)
const textsOf = (chatId = CHAT_ID) => chatMessages(chatId).map((message) => message.text)
const hasText = (chatId, predicate) => chatMessages(chatId).some((message) => predicate(message.text, message))
const buttons = (chatId = CHAT_ID) =>
  chatMessages(chatId)
    .filter((message) => message.reply_markup?.inline_keyboard)
    .flatMap((message) => message.reply_markup.inline_keyboard.flat())
const typingCount = (chatId = CHAT_ID) =>
  api.calls.filter((call) => call.method === 'sendChatAction' && Number(call.body.chat_id) === chatId).length
const callsOf = (method) => api.calls.filter((call) => call.method === method)
/** 消息 + 被编辑过的消息文本（结果回执走 editMessageText）。 */
const allTexts = (chatId = CHAT_ID) => [
  ...chatMessages(chatId).map((message) => message.text),
  ...api.edits.filter((edit) => edit.chat_id === chatId).map((edit) => edit.text),
]
const hasAnyText = (chatId, predicate) => allTexts(chatId).some((text) => predicate(text))
const callbackTexts = () => callsOf('answerCallbackQuery').map((call) => String(call.body.text ?? ''))

// ───────────────────────── 假 Cordis ctx 与服务 ─────────────────────────

const handlers = new Map()
const disposers = []
const sessions = new Map()
const createdOrder = []
let sessionSeq = 0

function createSession({ cwd = workDir, title = '' } = {}) {
  sessionSeq += 1
  const session = {
    sessionId: `session-${sessionSeq}`,
    title,
    cwd,
    running: false,
    agentPreset: 'standard',
    createdAt: Date.now(),
    events: [],
    queue: [],
    seq: 0,
    wake: null,
    promoters: [],
    renames: [],
    cancels: 0,
  }
  sessions.set(session.sessionId, session)
  createdOrder.push(session.sessionId)
  return session
}

function emitSession(sessionId, type, data) {
  const session = sessions.get(sessionId)
  if (!session) return
  session.seq += 1
  const event = { seq: session.seq, type, data }
  session.events.push(event)
  session.queue.push({ type: 'event', event })
  if (typeof session.wake === 'function') {
    const wake = session.wake
    session.wake = null
    wake()
  }
}

async function* followFrames(session, signal) {
  yield { type: 'snapshot', cursor: 0 }
  while (!signal.aborted) {
    if (session.queue.length === 0) {
      await new Promise((resolve) => {
        session.wake = resolve
        signal.addEventListener('abort', resolve, { once: true })
      })
      if (signal.aborted) return
      continue
    }
    yield session.queue.shift()
  }
}

const approvalHandler = () => handlers.get('approval/request')?.[0]
const questionHandler = () => handlers.get('user-questions/request')?.[0]

const services = {
  sessionController: {
    async create(request) {
      const session = createSession({ cwd: request?.cwd ?? workDir })
      return { sessionId: session.sessionId }
    },
    // Host 的真实签名是 prompt(request, signal)，缺 signal 会抛
    // "Cannot read properties of undefined (reading 'throwIfAborted')"
    async prompt(request, signal) {
      signal.throwIfAborted()
      const session = sessions.get(request?.sessionId)
      if (!session) throw new Error(`unknown session ${request?.sessionId}`)
      session.promoters.push(request)
      session.running = true
      return { ok: true }
    },
    follow({ address }, signal) {
      const session = sessions.get(address?.sessionId)
      if (!session) throw new Error(`unknown session ${address?.sessionId}`)
      services.sessionController.followCount += 1
      return followFrames(session, signal)
    },
    followCount: 0,
    async cancel({ sessionId }) {
      const session = sessions.get(sessionId)
      if (session) session.cancels += 1
      return { ok: true }
    },
    async fork({ sessionId }) {
      const session = sessions.get(sessionId)
      return { sessionId: createSession({ cwd: session?.cwd ?? workDir }).sessionId }
    },
    async rename({ sessionId, title }) {
      const session = sessions.get(sessionId)
      if (!session) throw new Error(`unknown session ${sessionId}`)
      session.title = title
      session.renames.push(title)
      return { sessionId, title }
    },
    async selectModel({ sessionId, provider, model }) {
      const session = sessions.get(sessionId)
      if (session) session.model = { provider, model }
      return { selected: { provider, model } }
    },
    async modelCatalog() {
      return {
        default: { provider: 'deepseek', model: 'deepseek-chat' },
        groups: [{ id: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }],
      }
    },
    async list() {
      return {
        items: [...sessions.values()].map((session) => ({
          sessionId: session.sessionId,
          cwd: session.cwd,
          running: session.running,
          updatedAt: session.createdAt,
          projections: { values: { title: session.title } },
        })),
      }
    },
    async inspect(sessionId) {
      const session = sessions.get(sessionId)
      if (!session) throw new Error(`unknown session ${sessionId}`)
      return {
        meta: {
          title: session.title,
          cwd: session.cwd,
          agentPreset: session.agentPreset,
          createdAt: session.createdAt,
        },
        events: session.events,
      }
    },
  },
  agents: {
    get: (sessionId) => (sessions.has(sessionId) ? { id: sessionId } : undefined),
  },
  tools: {
    schemas: () => [{ name: 'shell' }, { name: 'read_file' }],
    async execute({ name, arguments: args, agent }) {
      services.tools.lastCall = { name, args, agent: agent?.id }
      return { content: [{ type: 'text', text: '工具输出 OK' }] }
    },
    lastCall: null,
  },
  pluginManager: {
    async listPlugins() {
      return [{ id: 'include:telegram-control', name: 'telegram-control', enabled: true }]
    },
    async setPluginEnabled(id, enabled) {
      return { changed: true, id, enabled }
    },
    async listBundles() {
      return [{ name: 'dsh-telegram-control', version: '1.1.0', enabled: true }]
    },
    async installBundle(spec) {
      return { installed: spec }
    },
    async removeBundle(name) {
      return { removed: name }
    },
  },
  agentPresets: {
    async list() {
      return [{ id: 'standard', name: 'Standard' }]
    },
  },
  workingDirectory: { defaultDirectory: workDir },
}

const ctx = {
  logger: {
    info: () => {},
    warn: () => {},
    error: (...args) => console.log('  [host.logger.error]', ...args),
  },
  on(event, handler) {
    const list = handlers.get(event) ?? []
    list.push(handler)
    handlers.set(event, list)
    return () => {
      const at = list.indexOf(handler)
      if (at >= 0) list.splice(at, 1)
    }
  },
  effect(fn) {
    const disposer = fn()
    if (typeof disposer === 'function') disposers.push(disposer)
  },
  get(name) {
    return services[name]
  },
}

const plugin = await import('../index.js')
plugin.apply(ctx, {})

let exitCode = 1

try {
  // ───────────────────── 启动与命令菜单 ─────────────────────

  section('启动与命令菜单')
  await waitFor(() => callsOf('getMe').length > 0, 'getMe 已调用')
  await waitFor(() => callsOf('setMyCommands').length >= 3, 'setMyCommands 注册 default/私聊/群聊 三个作用域')
  {
    const scopes = callsOf('setMyCommands').map((call) => call.body.scope?.type)
    ok(scopes.includes('default') && scopes.includes('all_private_chats') && scopes.includes('all_group_chats'), '菜单作用域齐全', JSON.stringify(scopes))
    const commands = callsOf('setMyCommands')[0]?.body.commands ?? []
    ok(commands.length === 44, '命令菜单 44 条', `实际 ${commands.length}`)
    ok(commands.some((item) => item.command === 'lang') && commands.some((item) => item.command === 'power'), '菜单含 lang 与 power')
    ok(commands.every((item) => typeof item.description === 'string' && item.description.length > 0), '每条命令都有描述')
  }
  await waitFor(() => callsOf('setChatMenuButton').length > 0, 'setChatMenuButton 已调用')
  ok(
    callsOf('setChatMenuButton')[0]?.body.menu_button?.type === 'commands',
    '菜单按钮指向 commands',
    JSON.stringify(callsOf('setChatMenuButton')[0]?.body),
  )
  await waitFor(() => callsOf('setMyShortDescription').length > 0 && callsOf('setMyDescription').length > 0, 'Bot 简介与描述已注册')
  await waitFor(async () => (await readJson(statusPath))?.state === 'running', '运行状态写入 running')
  ok((await readJson(statusPath))?.botUsername === api.botUsername, '运行状态记录 bot 用户名')

  // ───────────────────────── 鉴权 ─────────────────────────

  section('鉴权')
  pushText('/myid')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes(`user_id: ${USER_ID}`)), '/myid 返回 user_id')
  {
    const before = chatMessages().length
    pushText('/status', { userId: 999999 })
    pushText('/status', { chatId: 2002 })
    await sleep(700)
    const forbidden = api.messages.slice(before).filter((message) => message.text.includes('状态：'))
    ok(forbidden.length === 0, '未授权的 user/chat 不会执行命令', JSON.stringify(forbidden.map((m) => m.text)))
    ok(
      api.messages.slice(before).some((message) => message.text.includes('未授权')),
      '未授权请求会收到提示',
      JSON.stringify(api.messages.slice(before).map((m) => m.text)),
    )
  }

  // ───────────────────── 命令分发 ─────────────────────

  section('命令分发')
  pushText('/help')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('DSH Telegram 控制台')), '/help 输出帮助')
  ok(hasText(CHAT_ID, (text) => text.includes('/shutdown') && text.includes('/lang')), '/help 含主机控制与语言命令')
  pushText('/version')
  const pkgVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes(pkgVersion)), `/version 输出版本号 ${pkgVersion}`)

  pushText('/about')
  await waitFor(
    () => hasText(CHAT_ID, (text) => text.includes(pkgVersion) && text.includes('pingmike2') && text.includes('github')),
    '/about 展示作者、仓库与版本',
  )
  pushText('/sessions')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('暂无会话')), '/sessions 空列表提示')
  pushText('/menu')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('已注册 44 条命令菜单')), '/menu 重新注册菜单')
  pushText('/pause')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('已暂停')), '/pause 暂停响应')
  pushText('/resume')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('已恢复')), '/resume 恢复响应')
  pushText('/status')
  await waitFor(
    () => hasText(CHAT_ID, (text) => text.includes('状态：') && text.includes('语言：zh')),
    '/status 输出运行状态',
  )

  // ───────────────────── prompt 桥接 ─────────────────────

  section('prompt 桥接与流式回流')
  const promptText = '你好，帮我看看这个仓库'
  pushText(promptText)
  await waitFor(() => sessions.size === 1, '自动创建并绑定会话')
  const firstSession = [...sessions.values()][0]
  await waitFor(() => firstSession.promoters.length === 1, 'prompt 已下发')
  ok(firstSession.promoters[0]?.content?.[0]?.text === promptText, 'prompt 内容正确', JSON.stringify(firstSession.promoters[0]?.content))
  ok(firstSession.promoters[0]?.mode === 'queue', 'prompt 走 queue 模式')
  await waitFor(() => typingCount() > 0, '下发时带 typing 状态')
  await waitFor(() => services.sessionController.followCount > 0, '会话流已订阅', 4000)

  emitSession(firstSession.sessionId, 'assistant/message', {
    message: { content: [{ type: 'text', text: '好的，我看一下' }] },
  })
  await waitFor(() => hasText(CHAT_ID, (text) => text === '好的，我看一下'), 'assistant 文本回流')

  emitSession(firstSession.sessionId, 'assistant/message', {
    message: { content: [{ type: 'reasoning', text: '这里是模型的内部推理' }, { type: 'text', text: '结论是没问题' }] },
  })
  await waitFor(() => hasText(CHAT_ID, (text) => text === '结论是没问题'), 'reasoning 与 text 混合时只发 text')
  ok(!hasText(CHAT_ID, (text) => text.includes('这里是模型的内部推理')), '思考过程默认不上屏')

  emitSession(firstSession.sessionId, 'assistant/live-chunk', { delta: '流式片段不该出现' })
  await sleep(400)
  ok(!hasText(CHAT_ID, (text) => text.includes('流式片段不该出现')), '逐 token 流式片段不上屏')

  emitSession(firstSession.sessionId, 'tool/call', { name: 'shell', arguments: { command: 'echo hi' } })
  {
    const before = typingCount()
    emitSession(firstSession.sessionId, 'tool/call', { name: 'edit', arguments: { path: 'a.txt' } })
    await waitFor(() => typingCount() > before, '工具调用刷新「正在输入…」状态')
    await sleep(300)
    ok(!hasText(CHAT_ID, (text) => text.startsWith('🔧')), '工具调用不再单独发消息', JSON.stringify(textsOf().slice(-3)))
    ok(!hasText(CHAT_ID, (text) => text.includes('a.txt')), '工具调用参数不上屏')
  }

  emitSession(firstSession.sessionId, 'tool/result', { name: 'shell', error: { name: 'TimeoutError', reason: 'took too long' } })
  emitSession(firstSession.sessionId, 'tool/result', { name: 'web_search', error: { name: 'WebError' } })
  await sleep(600)
  ok(!hasText(CHAT_ID, (text) => text.includes('工具失败')), '工具失败默认不上屏', JSON.stringify(textsOf().slice(-3)))
  ok(!hasText(CHAT_ID, (text) => text.includes('ToolNotFoundError')), 'ToolNotFoundError 一类噪音不上屏')

  emitSession(firstSession.sessionId, 'turn/end', { reason: { kind: 'completed' } })
  await waitFor(() => hasText(CHAT_ID, (text) => text === '✅ 本轮完成'), '回合结束提示')

  // ───────────────────── 工作中的「正在输入…」心跳 ─────────────────────

  section('工作期间持续 typing')
  {
    const before = typingCount()
    emitSession(firstSession.sessionId, 'turn/start', {})
    await sleep(9000)
    // 9 秒里没有任何事件，只靠心跳续命：至少续了两次
    ok(typingCount() - before >= 2, '整轮工作期间持续刷新「正在输入…」', `${before} → ${typingCount()}`)
    ok(!hasText(CHAT_ID, (text) => text.includes('正在输入')), 'typing 只是状态，不发消息')

    emitSession(firstSession.sessionId, 'turn/end', { reason: { kind: 'completed' } })
    await sleep(1200)
    const settled = typingCount()
    await sleep(5200)
    ok(typingCount() === settled, '回合结束后心跳停止', `${settled} → ${typingCount()}`)
  }

  // ───────────────────── 思考过程 ─────────────────────

  section('思考过程只显示状态')
  {
    await sleep(4200)
    const before = typingCount()
    emitSession(firstSession.sessionId, 'reasoning/delta', { delta: '思考中…' })
    await waitFor(() => typingCount() > before, '思考增量触发 typing 状态')
    const afterFirst = typingCount()
    for (let index = 0; index < 6; index += 1) {
      emitSession(firstSession.sessionId, 'reasoning/delta', { delta: `片段 ${index}` })
    }
    await sleep(400)
    ok(typingCount() - afterFirst <= 1, 'typing 有节流，不会每条增量都发', `${afterFirst} → ${typingCount()}`)
  }
  pushText('/reasoning on')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('思考过程也会发到这里')), '/reasoning on 打开转发')
  emitSession(firstSession.sessionId, 'assistant/message', {
    message: { content: [{ type: 'reasoning', text: '打开后可以看到的推理' }, { type: 'text', text: '最终回答' }] },
  })
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('打开后可以看到的推理')), '/reasoning on 后思考过程会转发')
  pushText('/reasoning off')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('只发最终回答')), '/reasoning off 关闭转发')

  // ───────────────────── shell / 文件 / 工具 ─────────────────────

  section('shell、文件与工具')
  pushText('/shell echo marker-246')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('$ echo marker-246')), '/shell 回显命令')
  ok(hasText(CHAT_ID, (text) => text.includes('exit=0') && text.includes('marker-246')), '/shell 输出与退出码')

  await writeFile(notePath, 'hello from telegram\n', 'utf8')
  pushText(`/read ${notePath}`)
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('hello from telegram')), '/read 读取文件')
  pushText(`/ls ${workDir}`)
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('note.txt')), '/ls 列出目录')

  const writtenPath = join(workDir, 'written.txt')
  pushText(`/write ${writtenPath}\n来自 Telegram 的内容`)
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('已写入')), '/write 写入文件')
  ok((await readFile(writtenPath, 'utf8')).includes('来自 Telegram 的内容'), '/write 内容落盘')

  pushText(`/cd ${backendDir}`)
  await sleep(300)
  pushText('/pwd')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('backend')), '/cd 后 /pwd 显示新目录')

  pushText('/tools')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('• shell')), '/tools 列出工具')
  pushText('/tool shell {"command":"echo hi"}')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('工具输出 OK')), '/tool 执行工具并回传结果')
  ok(services.tools.lastCall?.name === 'shell', '/tool 传对工具名', JSON.stringify(services.tools.lastCall))
  ok(services.tools.lastCall?.args?.command === 'echo hi', '/tool 传对 JSON 参数', JSON.stringify(services.tools.lastCall?.args))

  // ───────────────────── 会话命名与切换 ─────────────────────

  section('会话命名与切换')
  pushText('/new 我的前端项目')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('已绑定新会话')), '/new 新建会话')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('标题：我的前端项目')), '/new 直接命名')
  const titledSession = createdOrder.map((id) => sessions.get(id)).find((session) => session.title === '我的前端项目')
  ok(Boolean(titledSession), '标题已通过 rename 落库', JSON.stringify([...sessions.values()].map((s) => s.title)))

  pushText(`/new ${backendDir} | 后端重构`)
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('标题：后端重构')), '/new 目录 | 标题 命名')
  ok(
    [...sessions.values()].some((session) => session.title === '后端重构' && session.cwd === backendDir),
    '目录与标题分别生效',
    JSON.stringify([...sessions.values()].map((s) => [s.title, s.cwd])),
  )

  pushText('/sessions')
  await waitFor(
    () => hasText(CHAT_ID, (text) => text.includes('我的前端项目') && text.includes('后端重构')),
    '/sessions 列出会话标题',
  )
  ok(buttons().some((button) => String(button.callback_data).startsWith('s:')), '会话列表带切换按钮')

  {
    const backendSession = [...sessions.values()].find((session) => session.title === '后端重构')
    const listText = textsOf().find((text) => text.includes('后端重构') && text.includes('我的前端项目')) ?? ''
    const listLines = listText.split('\n')
    ok(listText.includes(backendSession.sessionId), '/sessions 输出完整会话 ID', listText.slice(0, 200))
    ok(
      listLines.some((line) => line === backendSession.sessionId) &&
        listLines.some((line) => line.includes('后端重构') && !line.includes(backendSession.sessionId)),
      '会话 ID 独占一行、与标题分行（便于长按复制）',
      JSON.stringify(listLines.slice(0, 6)),
    )
  }

  pushText('/info')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('🗂 当前会话') && text.includes('标题：后端重构')), '/info 显示当前会话标题')

  pushText('/use 我的前端项目')
  await waitFor(() => hasText(CHAT_ID, (text) => text.startsWith('🔗 已绑定会话：我的前端项目')), '/use 按标题切换')
  pushText('/use 前端')
  await waitFor(() => hasText(CHAT_ID, (text) => text.startsWith('🔗 已绑定会话：我的前端项目')), '/use 标题模糊匹配')
  pushText('/use 1')
  await waitFor(() => hasText(CHAT_ID, (text) => text.startsWith('🔗 已绑定会话')), '/use 按序号切换')
  await waitFor(async () => {
    const state = await readJson(statePath)
    return state?.chats?.[String(CHAT_ID)]?.sessionId === firstSession.sessionId
  }, '/use 1 绑定到第一个会话', 4000)

  pushText('/use 后端重构')
  await waitFor(() => hasText(CHAT_ID, (text) => text.startsWith('🔗 已绑定会话：后端重构')), '/use 切回后端重构')
  pushText('/status')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('当前会话：后端重构')), '/status 显示当前会话标题')

  {
    const sButton = buttons().find((button) => String(button.callback_data).startsWith('s:'))
    pushCallback(String(sButton.callback_data))
    await waitFor(() => callbackTexts().some((text) => text.includes('已切换到')), '点会话按钮切换')
    await waitFor(() => hasText(CHAT_ID, (text) => text.startsWith('🔗 已绑定会话')), '切换后回报绑定会话')
  }

  pushText('/rename 我的前端项目 v2')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('已改名为：我的前端项目 v2')), '/rename 改名')
  pushText('/fork')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('已分叉并绑定')), '/fork 分叉会话')
  const boundSessionId = createdOrder[createdOrder.length - 1]

  // ───────────────────────── 多会话订阅 ─────────────────────────

  section('多会话订阅')
  {
    ok(Boolean(sessions.get(firstSession.sessionId)), '存在可用于旁观的第二个会话')

    pushText(`/watch ${firstSession.sessionId}`)
    await waitFor(() => hasText(CHAT_ID, (text) => text.includes('👁 已订阅')), '/watch 追加订阅第二个会话')
    await waitFor(async () => {
      const state = await readJson(statePath)
      return (state?.chats?.[String(CHAT_ID)]?.watched ?? []).length === 2
    }, '订阅列表落盘为 2 个会话', 4000)

    emitSession(boundSessionId, 'assistant/message', { message: { content: [{ type: 'text', text: '主会话的回答' }] } })
    emitSession(firstSession.sessionId, 'assistant/message', {
      message: { content: [{ type: 'text', text: '旁观的回答' }] },
    })
    await waitFor(() => hasText(CHAT_ID, (text) => text.includes('主会话的回答')), '主会话输出回流')
    await waitFor(() => hasText(CHAT_ID, (text) => text.includes('旁观的回答')), '旁观会话输出也回流')
    ok(
      hasText(CHAT_ID, (text) => text.startsWith('🏷 ') && text.includes('旁观的回答')),
      '多开时消息带会话标签',
      JSON.stringify(textsOf().slice(-4)),
    )

    pushText('/watch')
    await waitFor(() => hasText(CHAT_ID, (text) => text.includes('正在订阅 2/5')), '/watch 列出订阅列表')
    ok(hasText(CHAT_ID, (text) => text.includes('📌')), '订阅列表标出主会话')

    const mainBefore = sessions.get(boundSessionId).promoters.length
    const sideBefore = sessions.get(firstSession.sessionId).promoters.length
    pushText('直达主会话')
    await waitFor(() => sessions.get(boundSessionId).promoters.length === mainBefore + 1, 'prompt 发给主会话')
    ok(sessions.get(firstSession.sessionId).promoters.length === sideBefore, 'prompt 不误发给旁观的会话')

    pushText(`/unwatch ${firstSession.sessionId}`)
    await waitFor(() => hasText(CHAT_ID, (text) => text.includes('✅ 已取消订阅')), '/unwatch 取消订阅')
    const before = chatMessages().length
    emitSession(firstSession.sessionId, 'assistant/message', {
      message: { content: [{ type: 'text', text: '不该出现的旁观消息' }] },
    })
    await sleep(600)
    ok(
      !hasText(CHAT_ID, (text) => text.includes('不该出现的旁观消息')) && chatMessages().length === before,
      '取消订阅后不再回流',
      JSON.stringify(textsOf().slice(-3)),
    )

    pushText(`/unwatch ${boundSessionId}`)
    await waitFor(() => hasText(CHAT_ID, (text) => text.includes('✅ 已取消订阅')), '/unwatch 取消主会话')
    await waitFor(async () => {
      const state = await readJson(statePath)
      return (state?.chats?.[String(CHAT_ID)]?.watched ?? []).length === 0
    }, '全部取消后订阅列表清空', 4000)

    pushText(`/use ${boundSessionId}`)
    await waitFor(() => hasText(CHAT_ID, (text) => text.startsWith('🔗 已绑定会话')), '/use 重新绑定')
    await waitFor(async () => {
      const state = await readJson(statePath)
      return (state?.chats?.[String(CHAT_ID)]?.watched ?? []).length >= 1
    }, '/use 把主会话重新放回订阅', 4000)

    // /unwatch all 之后发消息：主会话被自动重新订阅，输出照常回流
    pushText('/unwatch all')
    await waitFor(() => hasText(CHAT_ID, (text) => text.includes('已取消全部订阅')), '/unwatch all 全部取消')
    pushText('取消订阅后再发一条')
    await sleep(400)
    emitSession(boundSessionId, 'assistant/message', {
      message: { content: [{ type: 'text', text: '自动重订阅后的回答' }] },
    })
    await waitFor(() => hasText(CHAT_ID, (text) => text.includes('自动重订阅后的回答')), '发消息后主会话自动重新订阅')
  }

  // ───────────────────────── 审批接管 ─────────────────────────

  section('审批接管')
  pushText('/approvals on')
  await waitFor(() => hasText(CHAT_ID, (text) => text === '🔐 审批接管：on'), '/approvals on 生效')
  ok((await readJson(configPath))?.answerApprovals === true, '审批开关已落盘')

  {
    const handler = approvalHandler()
    ok(typeof handler === 'function', 'approval/request 已挂载')
    let decision
    const pending = (async () => {
      decision = await handler(
        {
          agent: { id: boundSessionId },
          toolName: 'shell',
          displayReason: { zh: '需要执行命令', en: 'needs to run a command' },
          signal: new AbortController().signal,
        },
        async () => 'delegate',
      )
    })()
    await waitFor(
      () => buttons().some((button) => String(button.callback_data).startsWith('a:')),
      '审批请求推送到 Telegram',
    )
    const allowButton = buttons().find(
      (button) => String(button.callback_data).startsWith('a:') && String(button.callback_data).endsWith(':1'),
    )
    ok(Boolean(allowButton?.callback_data), '审批按钮带 callback_data', JSON.stringify(buttons()))
    pushCallback(String(allowButton.callback_data))
    await pending
    ok(decision === 'allowed-once', '点允许 → allowed-once', String(decision))
    await waitFor(() => hasAnyText(CHAT_ID, (text) => text.includes('已允许一次')), '允许结果回执')
  }

  // ───────────────────────── 提问接管 ─────────────────────────

  section('提问接管')
  pushText('/questions on')
  await waitFor(() => hasText(CHAT_ID, (text) => text === '❓ 提问接管：on'), '/questions on 生效')

  {
    const handler = questionHandler()
    ok(typeof handler === 'function', 'user-questions/request 已挂载')
    let answer
    const pending = (async () => {
      answer = await handler(
        {
          agent: { id: boundSessionId },
          questions: [
            {
              id: 'q1',
              question: '选一个部署环境',
              options: [{ label: '预发' }, { label: '生产' }],
            },
          ],
          signal: new AbortController().signal,
        },
        async () => 'delegate',
      )
    })()
    await waitFor(() => hasText(CHAT_ID, (text) => text.includes('选一个部署环境')), '提问推送到 Telegram')
    const optionButton = buttons().find((button) => String(button.callback_data).startsWith('q:'))
    ok(Boolean(optionButton?.callback_data), '提问选项带 callback_data', JSON.stringify(buttons()))
    pushCallback(String(optionButton.callback_data))
    await pending
    ok(answer?.answers?.[0]?.selected?.[0] === '预发', '点选项 → 返回选项结果', JSON.stringify(answer))
  }

  // ───────────────────────── 电源控制 ─────────────────────────

  section('电源控制')
  pushText('/power')
  await waitFor(
    () => hasText(CHAT_ID, (text) => text.includes('🔌 主机与电源') && text.includes('电源权限：允许')),
    '/power 输出主机与电源状态',
  )

  const powerCalls = async () => {
    try {
      return (await readFile(powerLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }

  pushText('/shutdown 120')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('已安排 120 秒后关机')), '/shutdown 120 安排关机')
  await waitFor(async () => (await powerCalls()).some((args) => args.join(' ') === '/s /t 120'), '调用 shutdown /s /t 120')

  pushText('/cancel')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('已取消计划中的关机')), '/cancel 撤销计划中的关机')
  await waitFor(async () => (await powerCalls()).some((args) => args.join(' ') === '/a'), '调用 shutdown /a 撤销')

  pushText('/reboot 300')
  await waitFor(
    () => hasText(CHAT_ID, (text) => text.includes('已安排 300 秒后重启')),
    '/reboot 300 安排重启',
  )
  pushText('/cancel')
  await waitFor(async () => (await powerCalls()).filter((args) => args.join(' ') === '/a').length >= 2, '再次撤销重启')

  pushText('/shutdown now')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('立即关机')), '/shutdown now 需要二次确认')
  {
    const confirmButton = buttons().find(
      (button) => String(button.callback_data).startsWith('p:') && String(button.callback_data).endsWith(':1'),
    )
    ok(Boolean(confirmButton?.callback_data), '确认按钮带 callback_data', JSON.stringify(buttons()))
    const before = (await powerCalls()).length
    pushCallback(String(confirmButton.callback_data))
    await waitFor(async () => (await powerCalls()).length > before, '点确认后真正执行关机')
  }

  await patchConfig({ allowPower: false })
  await sleep(2600)
  pushText('/shutdown 120')
  await waitFor(
    () => hasText(CHAT_ID, (text) => text.includes('当前配置禁止电源操作')),
    'allowPower=false 时拒绝电源操作',
  )
  await patchConfig({ allowPower: true })
  await sleep(2600)
  pushText('/shutdown 30')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('已安排 30 秒后关机')), '恢复 allowPower 后可用')

  // ───────────────────────── i18n ─────────────────────────

  section('i18n 语言切换')
  pushText('/lang en')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('Language set to en')), '/lang en 切换语言')
  {
    const last = callsOf('setMyCommands').at(-1)
    const power = last?.body.commands?.find((item) => item.command === 'power')
    ok(power?.description === 'Host and power status', '菜单描述切到英文', JSON.stringify(power))
  }
  pushText('/help')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('DSH Telegram Console')), '/help 输出英文帮助')
  pushText('/status')
  await waitFor(
    () => hasText(CHAT_ID, (text) => text.includes('State:') && text.includes('Language: en')),
    '/status 输出英文状态',
  )
  pushText('/lang fr')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('Unsupported language: fr')), '/lang 拒绝不支持的语言')
  pushText('/lang zh')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('语言已切换为 zh')), '/lang zh 切回中文')
  pushText('/status')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('语言：zh')), '/status 回到中文')

  // ───────────────────────── 配置页 ─────────────────────────

  section('配置页')
  const configUrl = `http://127.0.0.1:${configPort}`
  await waitFor(async () => {
    try {
      const response = await fetch(`${configUrl}/health`)
      return response.ok
    } catch {
      return false
    }
  }, '配置页 /health 可用')

  const page = await (await fetch(`${configUrl}/`)).text()
  ok(page.includes('name="csrf"'), '配置页带 CSRF token')
  ok(page.includes('name="lang"'), '配置页有语言选择')
  ok(page.includes('name="thinkingStatus"'), '配置页有思考状态选择')
  ok(page.includes('name="format"'), '配置页有消息格式选择')
  const csrf = page.match(/name="csrf" value="([^"]+)"/)?.[1] ?? ''

  {
    const body = new URLSearchParams({ csrf: 'wrong', enabled: '1' })
    const response = await fetch(`${configUrl}/save`, { method: 'POST', body })
    ok(response.status === 400, 'CSRF 错误被拒绝', `status=${response.status}`)
  }

  {
    const form = new URLSearchParams({
      csrf,
      enabled: '1',
      lang: 'zh',
      botToken: baseConfig.botToken,
      apiBaseUrl,
      proxyUrl: 'none',
      allowedUserIds: String(USER_ID),
      allowedChatIds: String(CHAT_ID),
      workingDirectory: workDir,
      agentPreset: '',
      allowShell: '1',
      allowTools: '1',
      allowFs: '1',
      allowPower: '1',
      thinkingStatus: 'typing',
      format: 'markdown',
      notifyToolFailures: '1',
      powerExec: fixture,
      powerDefaultSeconds: '60',
      configPort: String(configPort),
      reloadSeconds: '2',
    })
    const response = await fetch(`${configUrl}/save`, { method: 'POST', body: form, redirect: 'manual' })
    ok(response.status === 302, '配置页保存成功', `status=${response.status}`)
    const saved = await readJson(configPath)
    ok(saved?.botToken === baseConfig.botToken && saved?.lang === 'zh', '保存后配置落盘且未丢失关键项', JSON.stringify(saved))
    ok(saved?.notifyToolCalls === undefined, '工具调用推送开关已移除', JSON.stringify(saved?.notifyToolCalls))
    ok(Array.isArray(saved?.allowedUserIds) && saved.allowedUserIds.includes(USER_ID), '保存后授权列表正确', JSON.stringify(saved?.allowedUserIds))
    ok(saved?.format === 'markdown', '保存后消息格式为 markdown', JSON.stringify(saved?.format))
    ok(saved?.notifyToolFailures === true, '保存后工具失败通知开关生效', JSON.stringify(saved?.notifyToolFailures))
  }

  const statusJson = await (await fetch(`${configUrl}/status`)).text()
  ok(statusJson.includes('"state"'), '配置页 /status 返回运行状态 JSON', statusJson.slice(0, 80))

  // ───────────────────── Markdown 渲染 ─────────────────────

  section('Markdown 渲染')
  await waitFor(async () => (await readJson(configPath))?.format === 'markdown', '配置页把 format=markdown 落盘', 4000)
  await sleep(2600)
  // 热加载会重建会话流，先下发一条 prompt 把 follower 挂回去
  const promoterCounts = new Map([...sessions.values()].map((s) => [s.sessionId, s.promoters.length]))
  pushText('markdown 渲染测试')
  await waitFor(
    () => [...sessions.values()].some((s) => s.promoters.length > (promoterCounts.get(s.sessionId) ?? 0)),
    '热加载后会话流重新挂载',
    8000,
  )
  const mdSession =
    [...sessions.values()].find((s) => s.promoters.length > (promoterCounts.get(s.sessionId) ?? 0)) ?? firstSession
  await sleep(300)

  const markdownSample = [
    '## 结论',
    '这是 **加粗** 和 `code` 还有 [链接](https://example.com)。',
    '',
    '- 第一项',
    '- 第二项 1.2.0',
    '',
    '| 列A | 列B |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '| 字段 | 值 | 含义 |',
    '| --- | --- | --- |',
    '| state | running | 插件在跑 |',
    '',
    '```js',
    'const a = `x`',
    '```',
  ].join('\n')

  emitSession(mdSession.sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: markdownSample }] } })
  await waitFor(() => api.markdownMessages.length > 0, 'Markdown 消息带 parse_mode=MarkdownV2', 6000)
  {
    const sent = api.markdownMessages.at(-1)
    ok(sent?.parse_mode === 'MarkdownV2', 'parse_mode 为 MarkdownV2', JSON.stringify(sent?.parse_mode))
    ok(sent?.text.includes('*结论*'), '标题转成粗体', sent?.text?.slice(0, 80))
    ok(sent?.text.includes('*加粗*'), '粗体转换正确')
    ok(sent?.text.includes('`code`'), '行内代码保留')
    ok(sent?.text.includes('• 第一项'), '列表转成项目符号')
    ok(sent?.text.includes('1\\.2\\.0'), '保留字符被转义')
    ok(sent?.text.includes('• *1*：2'), '两列表格翻成键值行', sent?.text?.slice(0, 200))
    ok(sent?.text.includes('• 字段：state · 值：running · 含义：插件在跑'), '多列表格退化成一行键值对', sent?.text?.slice(0, 200))
    ok(!(sent?.text ?? '').includes('|'), '表格不再留下裸管道符')
    ok(!/```[\s\S]*列A/.test(sent?.text ?? ''), '表格不再塞进等宽块')
    ok(sent?.text.includes('const a = \\`x\\`'), '代码块内容转义回来')
    ok(sent?.text.includes('[链接](https://example.com)'), '链接保留')
  }

  // 解析失败必须退回纯文本，不能丢消息
  api.rejectMarkdown = true
  emitSession(mdSession.sessionId, 'assistant/message', { message: { content: [{ type: 'text', text: '**兜底** 1.2.0' }] } })
  await waitFor(() => hasText(CHAT_ID, (text) => text === '**兜底** 1.2.0'), 'MarkdownV2 解析失败自动退回纯文本', 6000)
  api.rejectMarkdown = false

  // 打开开关后，工具失败才重新上屏
  emitSession(mdSession.sessionId, 'tool/result', { name: 'shell', error: { name: 'TimeoutError', reason: 'took too long' } })
  await waitFor(
    () => hasText(CHAT_ID, (text) => text.includes('工具失败') && text.includes('took too long')),
    '打开 notifyToolFailures 后工具失败才推送',
    6000,
  )

  // ───────────────────────── 热加载与卸载 ─────────────────────────

  section('热加载与卸载')
  await patchConfig({ thinkingStatus: 'message' })
  await waitFor(async () => (await readJson(configPath))?.thinkingStatus === 'message', '热加载：写入新配置', 3000)
  await sleep(2600)
  pushText('/status')
  await waitFor(() => hasText(CHAT_ID, (text) => text.includes('状态：')), '热加载后插件仍在运行且响应命令')

  section('轮询故障与恢复')
  {
    api.failGetUpdates = true
    await waitFor(async () => (await readJson(statusPath))?.state === 'degraded', '轮询失败时状态标记 degraded', 10_000)
    ok(
      typeof (await readJson(statusPath))?.stats?.lastError === 'string',
      'degraded 时带上 lastError 便于排查',
      JSON.stringify((await readJson(statusPath))?.stats),
    )
    api.failGetUpdates = false
    await waitFor(async () => (await readJson(statusPath))?.state === 'running', '恢复后状态回到 running', 20_000)
    ok((await readJson(statusPath))?.stats?.lastError === null, '恢复后 lastError 清空，不再一直显示故障')
  }

  {
    const before = chatMessages().length
    for (const dispose of disposers) dispose()
    await waitFor(async () => (await readJson(statusPath))?.state === 'stopped', '卸载后状态标记 stopped')
    pushText('/status')
    await sleep(800)
    ok(chatMessages().length === before, '卸载后不再响应消息', `消息数 ${before} → ${chatMessages().length}`)
  }

  ok(disposers.length > 0, 'ctx.effect 注册了可回收 disposer')

  section('小结')
  console.log(`  状态文件：${statusPath}`)
  console.log(`  配置文件：${configPath}`)
  console.log(`  会话：${[...sessions.values()].map((session) => `${session.sessionId}${session.title ? `(${session.title})` : ''}`).join(', ')}`)
  console.log(`  Telegram 消息数：${api.messages.length} · API 调用数：${api.calls.length}`)

  if (failed.length === 0) {
    console.log(`\n✅ 全部通过：${passed}/${passed}`)
    exitCode = 0
  } else {
    console.log(`\n❌ 失败 ${failed.length} 项（通过 ${passed}）：`)
    for (const label of failed) console.log(`   · ${label}`)
    console.log('\n最近消息：')
    for (const message of api.messages.slice(-8)) console.log(`   ${JSON.stringify(message.text)}`)
  }
} catch (error) {
  console.log(`\n❌ 测试异常终止：${error?.stack || error}`)
} finally {
  for (const dispose of disposers) {
    try {
      dispose()
    } catch {
      /* ignore */
    }
  }
  server.close()
  await rm(home, { recursive: true, force: true }).catch(() => {})
  process.exit(exitCode)
}
