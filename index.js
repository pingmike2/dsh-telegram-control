/**
 * DSH Telegram 控制台（Host 插件）
 *
 * 把 DeepSeek Harness 变成一个可以用 Telegram 远程操控的后端：
 *   - 会话：列出 / 新建 / 绑定 / 分叉 / 取消 / 改名
 *   - 对话：普通文本直接下发为 prompt，Agent 输出实时回流到 Telegram
 *   - 系统：shell 执行、文件读写、DSH 工具直调
 *   - 审批：接管 approval/request，用内联按钮批准或拒绝工具执行
 *   - 提问：接管 user-questions/request，把 ask_user_question 搬到手机上
 *   - 插件：列出、启停、安装、卸载 profile 插件与 bundle
 *
 * 只依赖 Node 内建模块，没有任何第三方依赖，因此可以在 profile 里直接链接安装。
 *
 * @module dsh-telegram-control
 */

import { execFileSync, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { request as httpRequest } from 'node:http'
import { cpus, homedir, hostname, totalmem } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { connect as tlsConnect } from 'node:tls'
import { fileURLToPath } from 'node:url'

/** Cordis 插件名（出现在 Loader 诊断里）。 */
export const name = 'telegram-control'
/** 插件版本。 */
export const version = '1.2.0'

/** 所有能力都在调用时按需通过 `ctx.get()` 解析，因此不声明硬依赖。 */
export const inject = []

const DEFAULTS = {
  enabled: true,
  lang: 'zh',
  botToken: '',
  apiBaseUrl: 'https://api.telegram.org',
  proxyUrl: 'auto',
  configPort: 59777,
  allowedUserIds: [],
  allowedChatIds: [],
  workingDirectory: '',
  agentPreset: '',
  pollTimeoutSeconds: 25,
  maxMessageChars: 3600,
  answerApprovals: false,
  answerQuestions: false,
  forwardReasoning: false,
  thinkingStatus: 'typing',
  approvalTimeoutSeconds: 120,
  commandTimeoutSeconds: 120,
  allowShell: true,
  allowTools: true,
  allowFs: true,
  allowPower: true,
  powerDefaultSeconds: 60,
  powerExec: '',
  shellPath: '',
  reloadSeconds: 5,
}

/** 表示“这次请求交回给后面的 answerer 处理”。 */
const DELEGATE = Symbol('delegate')

const OUTPUT_CAP = 200_000
const MAX_TOOL_NAME = 64

// ────────────────────────────── i18n ──────────────────────────────

/** 词表目录：与 index.js 同级的 locale/，随包发布。 */
const LOCALE_DIR = fileURLToPath(new URL('./locale/', import.meta.url))
/** 回退语言：任何缺失的键都从这里补。 */
const FALLBACK_LANG = 'zh'
const catalogCache = new Map()

function isSupportedLang(code) {
  return langList().includes(String(code ?? '').toLowerCase())
}

/** 可用语言：扫描 locale/*.json，失败时至少回退选项可用。 */
function langList() {
  try {
    const codes = readdirSync(LOCALE_DIR)
      .filter((file) => file.toLowerCase().endsWith('.json'))
      .map((file) => file.slice(0, -'.json'.length).toLowerCase())
      .filter((code) => /^[a-z]{2}(-[a-z]{2})?$/.test(code))
    if (codes.length > 0) return codes.sort()
  } catch {
    /* 目录不可读时走下面的回退 */
  }
  return [FALLBACK_LANG]
}

/** 读词表（带缓存，解析失败返回 null 由调用方回退）。 */
function loadCatalog(lang) {
  const code = String(lang ?? '').trim().toLowerCase()
  if (code.length === 0) return null
  if (catalogCache.has(code)) return catalogCache.get(code)
  let catalog = null
  try {
    const parsed = JSON.parse(readFileSync(join(LOCALE_DIR, `${code}.json`), 'utf8'))
    catalog = parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    catalog = null
  }
  catalogCache.set(code, catalog)
  return catalog
}

/** 当前语言代码；非法值回退到 FALLBACK_LANG。 */
function langOf(rt) {
  const code = String(rt?.cfg?.lang ?? FALLBACK_LANG).toLowerCase()
  return loadCatalog(code) ? code : FALLBACK_LANG
}

/**
 * 取一条文案。
 * @param {object} rt 运行时（读 rt.cfg.lang）。
 * @param {string} key 词表键。
 * @param {Record<string, unknown>} [vars] `{name}` 占位符。
 */
function t(rt, key, vars) {
  const primary = loadCatalog(langOf(rt))
  const fallback = loadCatalog(FALLBACK_LANG)
  const template = primary?.[key] ?? fallback?.[key] ?? key
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
  )
}

/** 语言感知的布尔开关文案：on/off。 */
function onOff(value) {
  return value ? 'on' : 'off'
}


// ────────────────────────────── 基础工具 ──────────────────────────────

/** DSH 家目录。 */
function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

function clampInt(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

function toNumberList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const parsed = typeof item === 'number' ? item : Number(String(item).trim())
    if (Number.isFinite(parsed)) out.push(Math.trunc(parsed))
  }
  return out
}

function safeLogger(ctx) {
  const logger = ctx?.logger
  const emit = (level) => (...parts) => {
    try {
      const fn = logger?.[level]
      if (typeof fn === 'function') fn.call(logger, ...parts)
    } catch {
      /* 日志失败不影响控制主流程 */
    }
  }
  return {
    info: emit('info'),
    warn: emit('warn'),
    error: emit('error'),
  }
}

function sleep(ms, signal) {
  return new Promise((resolvePromise) => {
    if (signal?.aborted) {
      resolvePromise()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolvePromise()
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    const onAbort = () => {
      clearTimeout(timer)
      resolvePromise()
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

function clip(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n…（已截断，共 ${value.length} 字符）`
}

function chunkText(text, max) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n')
  if (normalized.trim().length === 0) return []
  const chunks = []
  let rest = normalized
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max)
    if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max)
    if (cut < max * 0.5) cut = max
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n/, '')
  }
  if (rest.trim().length > 0) chunks.push(rest)
  return chunks
}

function shortId(id) {
  const value = String(id ?? '')
  return value.length <= 14 ? value : `${value.slice(0, 12)}…`
}

function formatTime(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value <= 0) return '未知'
  try {
    return new Date(value).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return new Date(value).toISOString()
  }
}

async function readJsonFile(path) {
  const text = await readFile(path, 'utf8')
  return JSON.parse(text)
}

async function writeJsonFile(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** 配置归一化：补默认值、校正类型，任何脏值都不会让插件启动失败。 */
function normalizeConfig(staticConfig, fileConfig) {
  const merged = {
    ...DEFAULTS,
    ...(staticConfig && typeof staticConfig === 'object' ? staticConfig : {}),
    ...(fileConfig && typeof fileConfig === 'object' ? fileConfig : {}),
  }
  const token = typeof merged.botToken === 'string' ? merged.botToken.trim() : ''
  return {
    enabled: merged.enabled !== false,
    lang: isSupportedLang(merged.lang) ? String(merged.lang).toLowerCase() : FALLBACK_LANG,
    botToken: token,
    apiBaseUrl: String(merged.apiBaseUrl || DEFAULTS.apiBaseUrl).replace(/\/+$/, ''),
    proxyUrl: normalizeProxySetting(merged.proxyUrl),
    configPort: clampInt(merged.configPort, 0, 65535, DEFAULTS.configPort),
    allowedUserIds: toNumberList(merged.allowedUserIds),
    allowedChatIds: toNumberList(merged.allowedChatIds),
    workingDirectory: typeof merged.workingDirectory === 'string' ? merged.workingDirectory.trim() : '',
    agentPreset: typeof merged.agentPreset === 'string' ? merged.agentPreset.trim() : '',
    pollTimeoutSeconds: clampInt(merged.pollTimeoutSeconds, 1, 50, DEFAULTS.pollTimeoutSeconds),
    maxMessageChars: clampInt(merged.maxMessageChars, 200, 4096, DEFAULTS.maxMessageChars),
    answerApprovals: merged.answerApprovals === true,
    answerQuestions: merged.answerQuestions === true,
    forwardReasoning: merged.forwardReasoning === true,
    thinkingStatus: ['typing', 'message', 'off'].includes(String(merged.thinkingStatus))
      ? String(merged.thinkingStatus)
      : 'typing',
    approvalTimeoutSeconds: clampInt(merged.approvalTimeoutSeconds, 10, 3600, DEFAULTS.approvalTimeoutSeconds),
    commandTimeoutSeconds: clampInt(merged.commandTimeoutSeconds, 1, 3600, DEFAULTS.commandTimeoutSeconds),
    allowShell: merged.allowShell !== false,
    allowTools: merged.allowTools !== false,
    allowFs: merged.allowFs !== false,
    allowPower: merged.allowPower !== false,
    powerDefaultSeconds: clampInt(merged.powerDefaultSeconds, 0, 86_400, DEFAULTS.powerDefaultSeconds),
    powerExec: typeof merged.powerExec === 'string' ? merged.powerExec.trim() : '',
    shellPath: typeof merged.shellPath === 'string' ? merged.shellPath.trim() : '',
    reloadSeconds: clampInt(merged.reloadSeconds, 2, 600, DEFAULTS.reloadSeconds),
  }
}

// ────────────────────── 代理与 HTTP 客户端 ──────────────────────

let proxyCache = { at: 0, value: '' }

/** 代理取值归一化：auto/空 → 自动探测；none/off/direct → 强制直连。 */
function normalizeProxySetting(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return 'auto'
  if (/^(none|off|direct|no)$/i.test(text)) return ''
  if (/^auto$/i.test(text)) return 'auto'
  return /^https?:\/\//i.test(text) ? text : `http://${text}`
}

/** 把 `host:port` / `socks=...;http=...` 归一化成一个 http:// URL。 */
function normalizeProxyUrl(server) {
  const parts = String(server)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
  const chosen = parts.find((part) => /^https?=/i.test(part)) ?? parts[0] ?? ''
  const cleaned = chosen.replace(/^[a-z]+=/i, '').trim()
  if (!cleaned) return ''
  return /^https?:\/\//i.test(cleaned) ? cleaned : `http://${cleaned}`
}

/**
 * 读取 Windows 系统代理。
 *
 * Node 的 `fetch`（undici）不认系统代理，而国内直连 api.telegram.org 基本都会超时，
 * 所以这里复用 WinINET 的设置做 CONNECT 隧道，插件无需重启也能联网。
 */
function detectSystemProxy() {
  if (process.platform !== 'win32') return ''
  if (Date.now() - proxyCache.at < 60_000) return proxyCache.value
  let value = ''
  try {
    const out = execFileSync(
      'reg',
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', windowsHide: true, timeout: 4000 },
    )
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x1/i.test(out)
    const server = out.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i)?.[1] ?? ''
    if (enabled && server) value = normalizeProxyUrl(server)
  } catch {
    /* 读不到就直连 */
  }
  proxyCache = { at: Date.now(), value }
  return value
}

/** 解析极简 HTTP/1.1 响应（Telegram 用 Content-Length，这里再兜住 chunked）。 */
function parseHttpResponse(buffer) {
  const split = buffer.indexOf('\r\n\r\n')
  if (split < 0) return { status: 0, text: buffer.toString('utf8') }
  const head = buffer.subarray(0, split).toString('utf8').split('\r\n')
  const status = Number(head[0]?.split(' ')[1] ?? 0)
  const headers = {}
  for (const line of head.slice(1)) {
    const at = line.indexOf(':')
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
  }
  let body = buffer.subarray(split + 4)
  if (String(headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) body = dechunk(body)
  return { status, text: body.toString('utf8'), headers }
}

function dechunk(buffer) {
  const out = []
  let at = 0
  while (at < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', at)
    if (lineEnd < 0) break
    const size = Number.parseInt(buffer.subarray(at, lineEnd).toString('utf8').trim(), 16)
    if (!Number.isFinite(size) || size <= 0) break
    const start = lineEnd + 2
    out.push(buffer.subarray(start, start + size))
    at = start + size + 2
  }
  return Buffer.concat(out)
}

/**
 * 经 HTTP 代理发一个请求（CONNECT 隧道 + 手写 HTTP/1.1）。
 * @returns {Promise<{status:number,text:string}>}
 */
function proxyRequest(proxyUrl, targetUrl, options) {
  const { method = 'POST', headers = {}, body = '', signal, timeoutMs = 40_000 } = options ?? {}
  const proxy = new URL(proxyUrl)
  const target = new URL(targetUrl)
  const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80))

  return new Promise((resolve, reject) => {
    let settled = false
    let timer = null
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      fn(value)
    }
    const onAbort = () => finish(reject, Object.assign(new Error('请求已取消'), { name: 'AbortError' }))
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    timer = setTimeout(() => {
      finish(reject, new Error(`代理请求超时（${timeoutMs}ms）`))
      connectReq.destroy()
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    const connectReq = httpRequest({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: `${target.hostname}:${targetPort}`,
      headers: { host: `${target.hostname}:${targetPort}` },
    })
    connectReq.once('error', (error) => finish(reject, error))
    connectReq.once('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy()
        finish(reject, Object.assign(new Error(`代理 CONNECT 失败（HTTP ${response.statusCode}）`), {
          status: response.statusCode,
        }))
        return
      }
      const stream =
        target.protocol === 'https:' ? tlsConnect({ socket, servername: target.hostname }) : socket
      stream.once('error', (error) => finish(reject, error))
      const payload = typeof body === 'string' ? body : ''
      const lines = [
        `${method} ${target.pathname}${target.search} HTTP/1.1`,
        `host: ${target.hostname}`,
        `content-length: ${Buffer.byteLength(payload)}`,
        'connection: close',
        ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
      ]
      stream.write(`${lines.join('\r\n')}\r\n\r\n${payload}`)
      const chunks = []
      stream.on('data', (chunk) => chunks.push(chunk))
      stream.on('end', () => finish(resolve, parseHttpResponse(Buffer.concat(chunks))))
      stream.on('close', () => finish(resolve, parseHttpResponse(Buffer.concat(chunks))))
    })
    connectReq.end()
  })
}

/** 统一 HTTP 入口：有代理走隧道，没代理用内建 fetch。 */
async function httpJson(rt, url, payload, signal) {
  const body = JSON.stringify(payload ?? {})
  const headers = { 'content-type': 'application/json' }
  if (rt.cfg.proxyUrl) {
    const response = await proxyRequest(rt.cfg.proxyUrl, url, {
      method: 'POST',
      headers,
      body,
      signal: signal ?? rt.ac.signal,
      timeoutMs: Math.max(10_000, (rt.cfg.pollTimeoutSeconds + 15) * 1000),
    })
    return { status: response.status, text: response.text }
  }
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
    signal: signal ?? rt.ac.signal,
  })
  return { status: response.status, text: await response.text() }
}

// ────────────────────────────── Telegram API ──────────────────────────────

async function tgCall(rt, method, params, signal) {
  const url = `${rt.cfg.apiBaseUrl}/bot${rt.cfg.botToken}/${method}`
  let response
  try {
    response = await httpJson(rt, url, params, signal)
  } catch (error) {
    const cause = error?.cause?.code || error?.cause?.message
    const suffix = cause ? `（${cause}${rt.cfg.proxyUrl ? '，代理 ' + rt.cfg.proxyUrl : '，未使用代理'}）` : ''
    throw Object.assign(new Error(`${method}: ${error?.message || error}${suffix}`), {
      status: error?.status,
      cause,
    })
  }
  const raw = response.text
  let data
  try {
    data = JSON.parse(raw)
  } catch {
    throw Object.assign(new Error(`${method}: HTTP ${response.status} ${clip(raw, 200)}`), {
      status: response.status,
    })
  }
  if (!data || data.ok !== true) {
    const error = new Error(`${method}: ${data?.description || `HTTP ${response.status}`}`)
    error.status = response.status
    error.apiCode = data?.error_code
    throw error
  }
  return data.result
}

async function sendText(rt, chatId, text, extra) {
  const chunks = chunkText(text, rt.cfg.maxMessageChars)
  if (chunks.length === 0) return undefined
  let last
  for (let index = 0; index < chunks.length; index += 1) {
    if (rt.ac.signal.aborted) return last
    const payload = { chat_id: chatId, text: chunks[index], disable_web_page_preview: true }
    if (index === chunks.length - 1 && extra) Object.assign(payload, extra)
    try {
      last = await tgCall(rt, 'sendMessage', payload)
    } catch (error) {
      rt.logger.warn(`telegram-control: sendMessage 失败 ${error?.message || error}`)
      return last
    }
  }
  return last
}

async function editMessage(rt, chatId, messageId, text, extra) {
  if (!messageId) return undefined
  const payload = { chat_id: chatId, message_id: messageId, text: clip(text, rt.cfg.maxMessageChars) }
  if (extra) Object.assign(payload, extra)
  try {
    return await tgCall(rt, 'editMessageText', payload)
  } catch (error) {
    rt.logger.warn(`telegram-control: editMessageText 失败 ${error?.message || error}`)
    return undefined
  }
}

async function sendTyping(rt, chatId) {
  try {
    await tgCall(rt, 'sendChatAction', { chat_id: chatId, action: 'typing' })
  } catch {
    /* 提示状态失败无关紧要 */
  }
}

/**
 * 把一条运行时开关写回配置文件。
 *
 * 配置热加载每 reloadSeconds 秒会用文件内容覆盖 `rt.cfg`，
 * 所以 /approvals、/reasoning、/lang 这类运行时开关必须落盘，否则几秒后就被重置。
 */
async function persistConfigPatch(rt, patch) {
  const configPath = join(dshHome(), 'telegram-control.json')
  try {
    const current = (await readJsonFile(configPath)) ?? {}
    await writeJsonFile(configPath, { ...current, ...patch, updatedAt: Date.now() })
    return true
  } catch (error) {
    rt.logger.warn(`telegram-control: 写回配置失败 ${error?.message || error}`)
    return false
  }
}
async function answerCallback(rt, callbackId, text) {
  try {
    await tgCall(rt, 'answerCallbackQuery', { callback_query_id: callbackId, text: clip(text, 190) })
  } catch {
    /* ignore */
  }
}

// ────────────────────── 本地配置页（填 token 的图形界面） ──────────────────────

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  )
}

function renderConfigPage(values, csrf, message, configPath) {
  const checked = (flag) => (flag ? ' checked' : '')
  const list = (value) => escapeHtml((Array.isArray(value) ? value : []).join(', '))
  const langOptionsHtml = (current) => {
    const codes = langList()
    const selected = codes.includes(String(current ?? '').toLowerCase()) ? String(current).toLowerCase() : FALLBACK_LANG
    return codes
      .map((code) => {
        const label = loadCatalog(code)?.['$meta']?.label ?? code
        return `<option value="${escapeHtml(code)}"${code === selected ? ' selected' : ''}>${escapeHtml(`${label} (${code})`)}</option>`
      })
      .join('')
  }
  const thinkingOptionsHtml = (current) => {
    const value = ['typing', 'message', 'off'].includes(String(current)) ? String(current) : 'typing'
    const rows = [
      ['typing', '只显示「正在输入…」状态（推荐）'],
      ['off', '不显示任何状态'],
    ]
    return rows
      .map(
        ([id, label]) =>
          `<option value="${id}"${id === value ? ' selected' : ''}>${escapeHtml(label)}</option>`,
      )
      .join('')
  }
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Telegram 控制台 · 配置</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 28px 18px; background: #0f1115; color: #e7e9ee; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.hint { color: #9aa3b2; margin: 0 0 18px; }
  fieldset { border: 1px solid #262b36; border-radius: 10px; margin: 0 0 16px; padding: 14px 16px 18px; }
  legend { color: #9aa3b2; padding: 0 6px; }
  label { display: block; margin: 12px 0 4px; color: #c8ced9; }
  input[type=text], input[type=number], textarea, select { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; border: 1px solid #2d3442; background: #151922; color: #e7e9ee; font: inherit; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .row > div { flex: 1 1 200px; }
  label.check { display: flex; align-items: center; gap: 8px; margin: 8px 0; color: #c8ced9; }
  button { margin-top: 18px; padding: 10px 20px; border-radius: 8px; border: 0; background: #3b82f6; color: #fff; font: inherit; cursor: pointer; }
  .msg { margin: 0 0 16px; padding: 10px 12px; border-radius: 8px; background: #14351f; border: 1px solid #1f6b3a; color: #b6f0c7; }
  code { background: #151922; padding: 2px 6px; border-radius: 6px; color: #9aa3b2; word-break: break-all; }
</style></head>
<body><main>
<h1>Telegram 控制台配置</h1>
<p class="hint">保存后 5 秒内生效，无需重启 DSH。文件：<code>${escapeHtml(configPath)}</code></p>
${message ? `<p class="msg">${escapeHtml(message)}</p>` : ''}
<form method="post" action="/save">
  <input type="hidden" name="csrf" value="${escapeHtml(csrf)}">
  <fieldset><legend>Bot</legend>
    <label>界面语言</label>
    <select name="lang">${langOptionsHtml(values.lang)}</select>
    <label>botToken（BotFather 给的）</label>
    <input type="text" name="botToken" value="${escapeHtml(values.botToken)}" placeholder="123456789:AA...">
    <div class="row">
      <div><label>允许的 user_id（逗号分隔）</label><input type="text" name="allowedUserIds" value="${list(values.allowedUserIds)}"></div>
      <div><label>允许的 chat_id（逗号分隔）</label><input type="text" name="allowedChatIds" value="${list(values.allowedChatIds)}"></div>
    </div>
    <p class="hint">不确定自己的 id？给 bot 发 <code>/myid</code>，它会把两个 id 回给你。</p>
  </fieldset>
  <fieldset><legend>网络</legend>
    <div class="row">
      <div><label>代理（auto = 用系统代理）</label><input type="text" name="proxyUrl" value="${escapeHtml(values.proxyUrl)}" placeholder="auto 或 http://127.0.0.1:10808"></div>
      <div><label>API 地址</label><input type="text" name="apiBaseUrl" value="${escapeHtml(values.apiBaseUrl)}"></div>
    </div>
  </fieldset>
  <fieldset><legend>Agent</legend>
    <div class="row">
      <div><label>默认工作目录</label><input type="text" name="workingDirectory" value="${escapeHtml(values.workingDirectory)}" placeholder="留空 = DSH 默认"></div>
      <div><label>Agent preset</label><input type="text" name="agentPreset" value="${escapeHtml(values.agentPreset)}" placeholder="留空 = standard"></div>
    </div>
  </fieldset>
  <fieldset><legend>开关</legend>
    <label class="check"><input type="checkbox" name="enabled"${checked(values.enabled)}> 启用插件</label>
    <label class="check"><input type="checkbox" name="answerApprovals"${checked(values.answerApprovals)}> 接管工具执行审批</label>
    <label class="check"><input type="checkbox" name="answerQuestions"${checked(values.answerQuestions)}> 接管 ask_user_question</label>
    <label class="check"><input type="checkbox" name="forwardReasoning"${checked(values.forwardReasoning)}> 把模型思考过程也发到 Telegram（默认关闭）</label>
    <label>思考时的状态提示</label>
    <select name="thinkingStatus">${thinkingOptionsHtml(values.thinkingStatus)}</select>
    <label class="check"><input type="checkbox" name="allowShell"${checked(values.allowShell)}> 允许 /shell</label>
    <label class="check"><input type="checkbox" name="allowTools"${checked(values.allowTools)}> 允许 /tool</label>
    <label class="check"><input type="checkbox" name="allowFs"${checked(values.allowFs)}> 允许 /read /write /ls</label>
    <label class="check"><input type="checkbox" name="allowPower"${checked(values.allowPower)}> 允许关机 / 重启 / 锁屏（/shutdown /reboot /lock）</label>
    <div class="row">
      <div><label>关机默认倒计时（秒）</label><input type="number" name="powerDefaultSeconds" value="${escapeHtml(values.powerDefaultSeconds)}"></div>
      <div><label>shutdown 命令路径（留空 = 系统默认）</label><input type="text" name="powerExec" value="${escapeHtml(values.powerExec ?? '')}"></div>
    </div>
    <div class="row">
      <div><label>配置页端口（0 = 关闭）</label><input type="number" name="configPort" value="${escapeHtml(values.configPort)}"></div>
      <div><label>刷新间隔（秒）</label><input type="number" name="reloadSeconds" value="${escapeHtml(values.reloadSeconds)}"></div>
    </div>
  </fieldset>
  <button type="submit">保存并生效</button>
</form>
</main></body></html>`
}

function toIdList(input) {
  return String(input ?? '')
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((value) => Number.isFinite(value))
}

function startConfigServer(options) {
  const { port, configPath, statusPath, csrf, logger } = options
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const send = (code, type, body) => {
      res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(body)
    }
    const currentFile = () =>
      readJsonFile(configPath)
        .then((value) => (value && typeof value === 'object' ? value : {}))
        .catch(() => ({}))

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/config')) {
      void currentFile().then((file) => {
        const values = { ...DEFAULTS, ...file }
        const message =
          url.searchParams.get('saved') === '1' ? '已保存，5 秒内生效。' : url.searchParams.get('error') || ''
        send(200, 'text/html; charset=utf-8', renderConfigPage(values, csrf, message, configPath))
      })
      return
    }
    if (req.method === 'GET' && url.pathname === '/status') {
      void readJsonFile(statusPath)
        .then((value) => send(200, 'application/json', JSON.stringify(value ?? {}, null, 2)))
        .catch(() => send(200, 'application/json', '{}'))
      return
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      send(200, 'application/json', '{"ok":true}')
      return
    }
    if (req.method === 'POST' && url.pathname === '/save') {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 65536) req.destroy()
      })
      req.on('end', () => {
        const form = new URLSearchParams(body)
        if (form.get('csrf') !== csrf) {
          send(400, 'text/plain; charset=utf-8', 'CSRF token 不匹配，请刷新配置页重试。')
          return
        }
        void currentFile().then(async (file) => {
          const next = {
            ...file,
            enabled: form.has('enabled'),
            lang: isSupportedLang(form.get('lang')) ? String(form.get('lang')).toLowerCase() : FALLBACK_LANG,
            botToken: String(form.get('botToken') ?? '').trim(),
            apiBaseUrl: String(form.get('apiBaseUrl') ?? '').trim() || DEFAULTS.apiBaseUrl,
            proxyUrl: String(form.get('proxyUrl') ?? '').trim() || 'auto',
            allowedUserIds: toIdList(form.get('allowedUserIds')),
            allowedChatIds: toIdList(form.get('allowedChatIds')),
            workingDirectory: String(form.get('workingDirectory') ?? '').trim(),
            agentPreset: String(form.get('agentPreset') ?? '').trim(),
            answerApprovals: form.has('answerApprovals'),
            answerQuestions: form.has('answerQuestions'),
            forwardReasoning: form.has('forwardReasoning'),
            thinkingStatus: String(form.get('thinkingStatus') ?? 'typing'),
            allowShell: form.has('allowShell'),
            allowTools: form.has('allowTools'),
            allowFs: form.has('allowFs'),
            allowPower: form.has('allowPower'),
            powerDefaultSeconds: clampInt(form.get('powerDefaultSeconds'), 0, 86_400, DEFAULTS.powerDefaultSeconds),
            powerExec: String(form.get('powerExec') ?? '').trim(),
            configPort: clampInt(form.get('configPort'), 0, 65535, DEFAULTS.configPort),
            reloadSeconds: clampInt(form.get('reloadSeconds'), 2, 600, DEFAULTS.reloadSeconds),
            updatedAt: Date.now(),
          }
          try {
            await writeJsonFile(configPath, next)
            res.writeHead(302, { location: '/?saved=1' })
            res.end()
          } catch (error) {
            logger?.warn?.(`telegram-control: 保存配置失败 ${error?.message || error}`)
            res.writeHead(302, { location: `/?error=${encodeURIComponent('保存失败：' + (error?.message || error))}` })
            res.end()
          }
        })
      })
      return
    }
    send(404, 'text/plain; charset=utf-8', 'not found')
  })
  const url = `http://127.0.0.1:${port}/`
  return {
    url,
    close: () =>
      new Promise((resolveClose) => {
        server.close(() => resolveClose())
        server.closeAllConnections?.()
      }),
    listen: () =>
      new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen)
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', rejectListen)
          resolveListen(url)
        })
      }),
  }
}

// ────────────────────────────── 运行时 ──────────────────────────────

function sessionController(rt) {
  try {
    return rt.ctx.get('sessionController')
  } catch {
    return undefined
  }
}

function getService(rt, name) {
  try {
    return rt.ctx.get(name)
  } catch {
    return undefined
  }
}

function defaultWorkingDirectory(rt) {
  const service = getService(rt, 'workingDirectory')
  if (service && typeof service.defaultDirectory === 'string' && service.defaultDirectory.length > 0) {
    return service.defaultDirectory
  }
  return process.cwd()
}

function chatDirectory(rt, chat) {
  return chat.cwd || rt.cfg.workingDirectory || defaultWorkingDirectory(rt)
}

function resolvePath(rt, chat, rawPath) {
  const value = String(rawPath ?? '').trim()
  if (value.length === 0) return chatDirectory(rt, chat)
  const cleaned = value.replace(/^"|"$/g, '')
  return isAbsolute(cleaned) ? resolve(cleaned) : resolve(chatDirectory(rt, chat), cleaned)
}

function getChat(rt, chatId) {
  let chat = rt.chats.get(chatId)
  if (!chat) {
    chat = {
      id: chatId,
      sessionId: undefined,
      cwd: undefined,
      userId: undefined,
      cursor: 0,
      followerAC: null,
      follower: null,
      queue: Promise.resolve(),
      lastList: [],
      lastDeniedAt: 0,
    }
    rt.chats.set(chatId, chat)
  }
  return chat
}

function enqueue(rt, chat, task) {
  chat.queue = chat.queue.then(task).catch((error) => {
    rt.logger.warn(`telegram-control: 处理消息失败 ${error?.stack || error?.message || error}`)
  })
  return chat.queue
}

function createRuntime(ctx, cfg, logger, statePath) {
  const rt = {
    ctx,
    cfg,
    logger,
    statePath,
    statusPath: join(dirname(statePath), 'telegram-control-status.json'),
    ac: new AbortController(),
    chats: new Map(),
    pending: new Map(),
    pendingText: new Map(),
    tokenSeq: 0,
    paused: false,
    approvalsEnabled: cfg.answerApprovals,
    questionsEnabled: cfg.answerQuestions,
    pollTask: null,
    offset: 0,
    saveTimer: null,
    startedAt: Date.now(),
    stats: { updates: 0, lastUpdateAt: 0, messages: 0, tools: 0, errors: 0, lastError: null },
    power: { pending: null, last: null },
    powerConfirm: new Map(),
    // chatId → 上次发送「正在输入…」状态的时间戳（节流用）
    thinkingAt: new Map(),
  }
  rt.start = async () => {
    await loadState(rt)
    try {
      const me = await tgCall(rt, 'getMe', {}, rt.ac.signal)
      if (me && typeof me === 'object') {
        rt.botInfo = { id: me.id ?? null, username: me.username ?? null, firstName: me.first_name ?? null }
        rt.logger.info(`telegram-control: 已连接 Bot @${me.username ?? me.id}`)
      }
    } catch (error) {
      rt.stats.errors += 1
      rt.stats.lastError = String(error?.message || error)
      rt.logger.warn(`telegram-control: getMe 失败 ${error?.message || error}`)
    }
    await registerBotCommands(rt).catch(() => {})
    rt.pollTask = pollLoop(rt)
  }
  rt.stop = async () => {
    rt.ac.abort()
    for (const chat of rt.chats.values()) stopFollower(chat)
    for (const entry of rt.pending.values()) {
      try {
        entry.abort?.()
      } catch {
        /* ignore */
      }
    }
    rt.pending.clear()
    rt.pendingText.clear()
    rt.powerConfirm.clear()
    rt.thinkingAt.clear()
    if (rt.saveTimer) {
      clearTimeout(rt.saveTimer)
      rt.saveTimer = null
    }
    await saveState(rt)
    try {
      await rt.pollTask
    } catch {
      /* ignore */
    }
  }
  return rt
}

async function loadState(rt) {
  try {
    const data = await readJsonFile(rt.statePath)
    const chats = data && typeof data.chats === 'object' && data.chats !== null ? data.chats : {}
    for (const [key, value] of Object.entries(chats)) {
      const chatId = Number(key)
      if (!Number.isFinite(chatId) || !value || typeof value !== 'object') continue
      const chat = getChat(rt, chatId)
      if (typeof value.sessionId === 'string' && value.sessionId.length > 0) chat.sessionId = value.sessionId
      if (typeof value.cwd === 'string' && value.cwd.length > 0) chat.cwd = value.cwd
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') rt.logger.warn(`telegram-control: 读取状态失败 ${error?.message || error}`)
  }
}

function scheduleSave(rt) {
  if (rt.saveTimer) return
  rt.saveTimer = setTimeout(() => {
    rt.saveTimer = null
    void saveState(rt)
  }, 800)
  if (typeof rt.saveTimer.unref === 'function') rt.saveTimer.unref()
}

async function saveState(rt) {
  const chats = {}
  for (const [id, chat] of rt.chats) {
    if (!chat.sessionId && !chat.cwd) continue
    chats[String(id)] = { sessionId: chat.sessionId ?? null, cwd: chat.cwd ?? null }
  }
  try {
    await writeJsonFile(rt.statePath, { version: 1, updatedAt: Date.now(), chats })
  } catch (error) {
    rt.logger.warn(`telegram-control: 写入状态失败 ${error?.message || error}`)
  }
}

/**
 * 写运行状态快照（系统级健康检查表面）。
 * 面板/脚本无需 Telegram 即可确认插件是否在跑、轮询是否正常。
 */
async function writeStatus(rt, state, extra) {
  const snapshot = {
    version,
    state,
    pid: process.pid,
    startedAt: rt?.startedAt ?? null,
    updatedAt: Date.now(),
    bot: rt ? maskToken(rt.cfg.botToken) : null,
    botUsername: rt?.botInfo?.username ?? null,
    botCommands: rt?.botCommands ?? 0,
    power: rt
      ? {
          allow: rt.cfg.allowPower,
          pending: rt.power?.pending ?? null,
          last: rt.power?.last ?? null,
        }
      : null,
    apiBaseUrl: rt?.cfg.apiBaseUrl ?? null,
    paused: rt ? rt.paused === true : null,
    chats: rt ? rt.chats.size : 0,
    boundSessions: rt ? [...rt.chats.values()].filter((chat) => typeof chat.sessionId === 'string').length : 0,
    approvalsEnabled: rt ? rt.approvalsEnabled === true : null,
    questionsEnabled: rt ? rt.questionsEnabled === true : null,
    stats: rt ? { ...rt.stats } : null,
    ...(extra && typeof extra === 'object' ? extra : {}),
  }
  try {
    await writeJsonFile(rt?.statusPath ?? join(dshHome(), 'telegram-control-status.json'), snapshot)
  } catch (error) {
    rt?.logger?.warn?.(`telegram-control: 写入运行状态失败 ${error?.message || error}`)
  }
  return snapshot
}

/** 只保留 token 的 bot id 与末 4 位，避免把凭据写进状态文件。 */
function maskToken(token) {
  if (typeof token !== 'string' || token.length === 0) return ''
  const [id, secret] = token.split(':')
  if (!secret) return '***'
  return `${id}:***${secret.slice(-4)}`
}

// ────────────────────────────── 轮询 ──────────────────────────────

async function pollLoop(rt) {
  let backoff = 1000
  while (!rt.ac.signal.aborted) {
    let updates
    try {
      updates = await tgCall(
        rt,
        'getUpdates',
        {
          offset: rt.offset,
          timeout: rt.cfg.pollTimeoutSeconds,
          allowed_updates: ['message', 'channel_post', 'callback_query'],
        },
        rt.ac.signal,
      )
      backoff = 1000
    } catch (error) {
      if (rt.ac.signal.aborted) break
      const status = Number(error?.status)
      if (status === 401 || status === 404) {
        rt.stats.errors += 1
        rt.stats.lastError = `botToken 无效或群组不可用（HTTP ${status}）`
        rt.logger.error('telegram-control: botToken 无效或群组不可用，轮询停止')
        break
      }
      rt.stats.errors += 1
      rt.stats.lastError = String(error?.message || error)
      rt.logger.warn(`telegram-control: getUpdates 失败 ${error?.message || error}`)
      await sleep(status === 409 ? 10_000 : backoff, rt.ac.signal)
      backoff = Math.min(backoff * 2, 30_000)
      continue
    }
    if (!Array.isArray(updates)) continue
    if (updates.length > 0) {
      rt.stats.updates += updates.length
      rt.stats.lastUpdateAt = Date.now()
    }
    for (const update of updates) {
      const updateId = Number(update?.update_id)
      if (Number.isFinite(updateId)) rt.offset = Math.max(rt.offset, updateId + 1)
      if (update?.message || update?.channel_post) rt.stats.messages += 1
      void handleUpdate(rt, update)
    }
  }
}

// ────────────────────────────── 更新分发 ──────────────────────────────

async function handleUpdate(rt, update) {
  try {
    if (update?.callback_query) {
      await handleCallback(rt, update.callback_query)
      return
    }
    const message = update?.message ?? update?.channel_post
    if (!message) return
    await handleMessage(rt, message)
  } catch (error) {
    rt.logger.warn(`telegram-control: 更新处理异常 ${error?.stack || error?.message || error}`)
  }
}

function isAllowed(rt, chatId, userId) {
  const { allowedChatIds, allowedUserIds } = rt.cfg
  if (allowedChatIds.length === 0 && allowedUserIds.length === 0) return false
  if (allowedChatIds.length > 0 && !allowedChatIds.includes(Number(chatId))) return false
  if (allowedUserIds.length > 0 && !allowedUserIds.includes(Number(userId))) return false
  return true
}

function denyText(rt, chatId, userId) {
  return [
    '⛔ 未授权',
    `chat_id: ${chatId}`,
    `user_id: ${userId}`,
    '',
    `请把 chat_id / user_id 写入 ${join(dshHome(), 'telegram-control.json')} 的 allowedChatIds / allowedUserIds 后重试。`,
    `当前名单：chat=${JSON.stringify(rt.cfg.allowedChatIds)} user=${JSON.stringify(rt.cfg.allowedUserIds)}`,
  ].join('\n')
}

async function handleMessage(rt, message) {
  const chatId = Number(message?.chat?.id)
  if (!Number.isFinite(chatId)) return
  if (message?.from?.is_bot === true) return
  const userId = Number(message?.from?.id)
  const text = typeof message?.text === 'string' ? message.text : ''

  if (!isAllowed(rt, chatId, userId)) {
    const command = parseCommand(text)
    if (command && (command.name === 'myid' || command.name === 'help')) {
      await sendText(rt, chatId, `chat_id: ${chatId}\nuser_id: ${userId}\n\n${denyText(rt, chatId, userId)}`)
      return
    }
    const chat = getChat(rt, chatId)
    const now = Date.now()
    if (now - chat.lastDeniedAt > 60_000) {
      chat.lastDeniedAt = now
      await sendText(rt, chatId, denyText(rt, chatId, userId))
    }
    return
  }

  const chat = getChat(rt, chatId)
  chat.userId = userId
  await enqueue(rt, chat, async () => {
    const questionToken = rt.pendingText.get(chatId)
    if (questionToken && text.length > 0 && !text.startsWith('/')) {
      const entry = rt.pending.get(questionToken)
      if (entry && entry.kind === 'question') {
        rt.pendingText.delete(chatId)
        entry.settle('custom', text)
        return
      }
      rt.pendingText.delete(chatId)
    }

    const command = parseCommand(text)
    if (command) {
      if (rt.paused && command.name !== 'resume' && command.name !== 'start' && command.name !== 'status') {
        await sendText(rt, chatId, '⏸ 已暂停，发送 /resume 恢复')
        return
      }
      await runCommand(rt, chat, command.name, command.args)
      return
    }

    if (text.trim().length === 0) {
      await sendText(rt, chatId, '暂时只处理文本消息。')
      return
    }
    await promptSession(rt, chat, text)
  })
}

function parseCommand(text) {
  const value = String(text ?? '')
  if (!value.startsWith('/')) return null
  const match = /^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/.exec(value)
  if (!match) return null
  return { name: match[1].toLowerCase(), args: match[2] ?? '' }
}

async function handleCallback(rt, query) {
  const chatId = Number(query?.message?.chat?.id)
  const userId = Number(query?.from?.id)
  if (!Number.isFinite(chatId)) return
  if (!isAllowed(rt, chatId, userId)) {
    await answerCallback(rt, query.id, '未授权')
    return
  }
  const data = String(query?.data ?? '')
  const [kind, token, value] = data.split(':')
  if (kind === 's') {
    const chat = getChat(rt, chatId)
    const item = chat.lastList?.[Number(token) - 1]
    if (!item?.sessionId) {
      await answerCallback(rt, query.id, '列表已过期，请重新 /sessions')
      return
    }
    stopFollower(chat)
    chat.sessionId = item.sessionId
    chat.cursor = 0
    scheduleSave(rt)
    ensureFollower(rt, chat)
    await answerCallback(rt, query.id, `已切换到 ${item.title || shortId(item.sessionId)}`)
    await sendText(
      rt,
      chatId,
      `🔗 已绑定会话${item.title ? `：${item.title}` : ''}\n${item.sessionId}`,
    )
    return
  }
  if (kind === 'p') {
    const request = rt.powerConfirm.get(token)
    if (!request) {
      await answerCallback(rt, query.id, '该确认已失效')
      return
    }
    rt.powerConfirm.delete(token)
    if (value !== '1') {
      await answerCallback(rt, query.id, '已取消')
      await sendText(rt, chatId, '✖ 已取消电源操作')
      return
    }
    await answerCallback(rt, query.id, '正在执行')
    await applyPower(rt, chatId, request.action, request.seconds)
    return
  }
  const entry = rt.pending.get(token)
  if (!entry || entry.kind !== (kind === 'a' ? 'approval' : 'question')) {
    await answerCallback(rt, query.id, '该请求已失效')
    return
  }
  if (entry.kind === 'approval') {
    const allow = value === '1'
    await answerCallback(rt, query.id, allow ? '已允许一次' : '已拒绝')
    entry.settle(allow ? 'allowed-once' : 'rejected', allow ? '✅ 已允许一次' : '⛔ 已拒绝')
    return
  }
  if (value === '#') {
    rt.pendingText.set(chatId, token)
    await answerCallback(rt, query.id, '请直接发送答案')
    await sendText(rt, chatId, '✍️ 请直接发送你的答案文本。')
    return
  }
  if (value === '-1') {
    await answerCallback(rt, query.id, '已取消')
    entry.settle('delegate', null)
    return
  }
  const index = Number(value)
  const option = entry.options?.[index]
  if (!option) {
    await answerCallback(rt, query.id, '选项已失效')
    return
  }
  await answerCallback(rt, query.id, `已选择：${option.label}`)
  entry.settle('option', option)
}

// ────────────────────────────── 会话桥接 ──────────────────────────────

async function ensureSession(rt, chat) {
  if (chat.sessionId) return chat.sessionId
  const controller = sessionController(rt)
  if (!controller) throw new Error('sessionController 不可用（Host 未加载 api-session-controller）')
  const request = { cwd: chatDirectory(rt, chat) }
  if (rt.cfg.agentPreset) request.agentPreset = rt.cfg.agentPreset
  const value = await controller.create(request)
  chat.sessionId = value?.sessionId
  chat.cursor = 0
  scheduleSave(rt)
  return chat.sessionId
}

function stopFollower(chat) {
  if (chat.followerAC) {
    chat.followerAC.abort()
    chat.followerAC = null
  }
  chat.follower = null
}

function ensureFollower(rt, chat) {
  if (!chat.sessionId || chat.followerAC) return
  const controller = sessionController(rt)
  if (!controller || typeof controller.follow !== 'function') return
  const ac = new AbortController()
  chat.followerAC = ac
  const sessionId = chat.sessionId
  const run = async () => {
    let stream
    try {
      stream = controller.follow({ address: { kind: 'session', sessionId }, assistantStream: false }, ac.signal)
    } catch (error) {
      rt.logger.warn(`telegram-control: 无法订阅会话流 ${error?.message || error}`)
      if (chat.followerAC === ac) {
        chat.followerAC = null
        chat.follower = null
      }
      return
    }
    try {
      for await (const frame of stream) {
        if (ac.signal.aborted || chat.sessionId !== sessionId) break
        if (!frame) continue
        if (frame.type === 'snapshot') {
          chat.cursor = Number(frame.cursor) || 0
          continue
        }
        if (frame.type !== 'event') continue
        const event = frame.event
        const seq = Number(event?.seq)
        if (!Number.isFinite(seq) || seq <= chat.cursor) continue
        chat.cursor = seq
        await onSessionEvent(rt, chat, event)
      }
    } catch (error) {
      if (!ac.signal.aborted) rt.logger.warn(`telegram-control: 会话流中断 ${error?.message || error}`)
    } finally {
      if (chat.followerAC === ac) {
        chat.followerAC = null
        chat.follower = null
      }
    }
  }
  chat.follower = run()
}

function blocksText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/** 模型的思考过程（DSH 里是 { type: 'reasoning', text }，部分 provider 用 thinking）。 */
function reasoningText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if ((block.type === 'reasoning' || block.type === 'thinking') && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/** 思考状态节流：TG 的 typing 状态只保持约 5 秒，这里最多每 4 秒发一次。 */
const THINKING_PULSE_MS = 4000

/**
 * 让 Telegram 显示「对方正在输入…」状态。
 * 思考过程本身不上屏，只用一个状态提示"机器人在想"。
 */
async function pulseThinking(rt, chatId, force = false) {
  const mode = rt.cfg.thinkingStatus
  if (mode === 'off') return
  const now = Date.now()
  const last = rt.thinkingAt.get(chatId) ?? 0
  if (!force && now - last < THINKING_PULSE_MS) return
  rt.thinkingAt.set(chatId, now)
  await sendTyping(rt, chatId)
}

async function onSessionEvent(rt, chat, event) {
  switch (event.type) {
    case 'assistant/message': {
      const content = event.data?.message?.content
      // 思考过程默认不上屏：只有显式 /reasoning on 才转发
      if (rt.cfg.forwardReasoning) {
        const thinking = reasoningText(content)
        if (thinking.length > 0) await sendText(rt, chat.id, `${t(rt, 'reasoning.prefix')}\n${clip(thinking, 3500)}`)
      }
      const text = blocksText(content)
      if (text.length > 0) await sendText(rt, chat.id, text)
      return
    }
    case 'assistant/live-chunk':
    case 'assistant/chunk':
    case 'assistant/delta':
    case 'reasoning/delta':
    case 'reasoning/start':
    case 'reasoning/end':
    case 'model/delta': {
      // 逐 token 的流式片段（含思考增量）一律不上屏，只让 Web UI 用；
      // Telegram 侧只保留一个「正在输入…」状态。
      await pulseThinking(rt, chat.id)
      return
    }
    case 'turn/start':
    case 'step/start': {
      await pulseThinking(rt, chat.id)
      return
    }
    case 'tool/call': {
      // 工具调用不上屏，只刷新「正在输入…」状态：
      // 手机上连发 🔧 工具名 属于纯噪音，进度感交给状态即可。
      await pulseThinking(rt, chat.id, true)
      return
    }
    case 'tool/result': {
      // 只有失败才值得占用一条消息；成功静默回流到最终回答里。
      const error = event.data?.error
      if (error && typeof error === 'object') {
        const line = [error.name ?? 'error', error.reason ?? ''].filter(Boolean).join(' ')
        await sendText(rt, chat.id, `⚠️ ${t(rt, 'tool.failed', { detail: clip(line, 200) })}`)
      }
      return
    }
    case 'turn/end': {
      const reason = event.data?.reason ?? { kind: 'completed' }
      await sendText(rt, chat.id, describeTurnEnd(reason))
      return
    }
    case 'approval/request': {
      return
    }
    default:
      return
  }
}

function describeTurnEnd(reason) {
  switch (reason?.kind) {
    case 'completed':
      return '✅ 本轮完成'
    case 'aborted':
      return '⏹ 本轮已中止'
    case 'blocked':
      return '⛔ 本轮被拦截'
    case 'error':
      return `❌ 本轮失败：${reason?.error?.message ?? '未知错误'}`
    case 'max-tokens':
      return '✂️ 达到 token 上限'
    case 'interrupted':
      return '⏹ 本轮被中断'
    case 'forked':
      return '🌿 会话已分叉'
    default:
      return `ℹ️ 回合结束：${reason?.kind ?? 'unknown'}`
  }
}

async function promptSession(rt, chat, text) {
  const controller = sessionController(rt)
  if (!controller) {
    await sendText(rt, chat.id, '❌ sessionController 不可用，无法下发 prompt。')
    return
  }
  let sessionId
  try {
    sessionId = await ensureSession(rt, chat)
  } catch (error) {
    await sendText(rt, chat.id, `❌ 创建会话失败：${error?.message || error}`)
    return
  }
  ensureFollower(rt, chat)
  if (rt.cfg.thinkingStatus !== 'off') await sendTyping(rt, chat.id)
  try {
    await controller.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    })
  } catch (error) {
    await sendText(rt, chat.id, `❌ 下发失败：${error?.message || error}\n会话：${sessionId}`)
  }
}

// ────────────────────────────── 审批 / 提问接管 ──────────────────────────────

function chatIdForSession(rt, sessionId) {
  if (!sessionId) return undefined
  for (const [id, chat] of rt.chats) {
    if (chat.sessionId === sessionId) return id
  }
  return undefined
}

function nextToken(rt) {
  rt.tokenSeq += 1
  return `${rt.tokenSeq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

async function approvalBridge(rt, request, next) {
  if (!rt.approvalsEnabled) return next()
  const chatId = chatIdForSession(rt, request?.agent?.id)
  if (chatId === undefined) return next()
  try {
    return await askApproval(rt, chatId, request)
  } catch (error) {
    rt.logger.warn(`telegram-control: 审批接管失败 ${error?.message || error}`)
    return next()
  }
}

function approvalReason(request) {
  const display = request?.displayReason
  if (display && typeof display === 'object') {
    if (typeof display.zh === 'string' && display.zh.length > 0) return display.zh
    if (typeof display.en === 'string' && display.en.length > 0) return display.en
  }
  if (typeof request?.reason === 'string' && request.reason.length > 0) return request.reason
  return ''
}

function askApproval(rt, chatId, request) {
  const token = nextToken(rt)
  const reason = approvalReason(request)
  const header = [
    '🔐 工具执行审批',
    `会话：${shortId(request?.agent?.id)}`,
    `工具：${request?.toolName ?? '未知'}`,
  ]
  if (reason.length > 0) header.push(`原因：${reason}`)
  const text = `${header.join('\n')}\n\n允许一次 / 拒绝？`

  return new Promise((resolvePromise) => {
    let settled = false
    const entry = {
      kind: 'approval',
      chatId,
      messageId: undefined,
      abort: () => finish('cancelled', '⏹ 请求已取消'),
      settle: (outcome, note) => finish(outcome, note),
    }
    const finish = (outcome, note) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request?.signal?.removeEventListener?.('abort', onAbort)
      rt.pending.delete(token)
      if (entry.messageId) {
        void editMessage(rt, chatId, entry.messageId, `${text}\n\n→ ${note}`, { reply_markup: { inline_keyboard: [] } })
      }
      resolvePromise(outcome)
    }
    const timer = setTimeout(() => finish('cancelled', '⌛ 超时，按取消处理'), rt.cfg.approvalTimeoutSeconds * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    const onAbort = () => finish('cancelled', '⏹ 请求已取消')
    if (request?.signal?.aborted) {
      finish('cancelled', '⏹ 请求已取消')
      return
    }
    request?.signal?.addEventListener?.('abort', onAbort, { once: true })
    rt.pending.set(token, entry)
    void (async () => {
      try {
        const message = await tgCall(rt, 'sendMessage', {
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ 允许一次', callback_data: `a:${token}:1` },
                { text: '⛔ 拒绝', callback_data: `a:${token}:0` },
              ],
            ],
          },
        })
        entry.messageId = message?.message_id
        if (settled) {
          await editMessage(rt, chatId, entry.messageId, `${text}\n\n→ 请求已结束`, { reply_markup: { inline_keyboard: [] } })
        }
      } catch (error) {
        rt.logger.warn(`telegram-control: 审批消息发送失败 ${error?.message || error}`)
        finish('unavailable', '⚠️ 审批消息发送失败')
      }
    })()
  })
}

async function questionBridge(rt, request, next) {
  if (!rt.questionsEnabled) return next()
  const chatId = chatIdForSession(rt, request?.agent?.id)
  if (chatId === undefined) return next()
  const items = Array.isArray(request?.questions) ? request.questions : []
  if (items.length !== 1) return next()
  try {
    const result = await askQuestion(rt, chatId, items[0], request)
    if (result === DELEGATE) return next()
    return result
  } catch (error) {
    rt.logger.warn(`telegram-control: 提问接管失败 ${error?.message || error}`)
    return next()
  }
}

function askQuestion(rt, chatId, item, request) {
  const token = nextToken(rt)
  const options = Array.isArray(item?.options) ? item.options.slice(0, 8) : []
  const header = ['❓ Agent 需要你确认']
  if (item?.header) header.push(`【${item.header}】`)
  header.push(String(item?.question ?? ''))
  if (item?.detail) header.push(String(item.detail))
  const text = header.filter((line) => typeof line === 'string' && line.length > 0).join('\n')

  return new Promise((resolvePromise) => {
    let settled = false
    const rows = options.map((option, index) => [
      { text: String(option?.label ?? `选项 ${index + 1}`).slice(0, 60), callback_data: `q:${token}:${index}` },
    ])
    rows.push([{ text: '✍️ 直接输入答案', callback_data: `q:${token}:#` }])
    rows.push([{ text: '⛔ 取消', callback_data: `q:${token}:-1` }])

    const entry = {
      kind: 'question',
      chatId,
      messageId: undefined,
      options,
      abort: () => settle('delegate', null),
      settle: (mode, payload) => settle(mode, payload),
    }
    const settle = (mode, payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request?.signal?.removeEventListener?.('abort', onAbort)
      rt.pending.delete(token)
      rt.pendingText.delete(chatId)
      let answer
      let note
      if (mode === 'option') {
        answer = { answers: [{ id: String(item?.id ?? ''), selected: [String(payload?.label ?? '')] }] }
        note = `✅ 已选择：${payload?.label ?? ''}`
      } else if (mode === 'custom') {
        answer = { answers: [{ id: String(item?.id ?? ''), selected: [], custom: String(payload ?? '') }] }
        note = `✅ 已回复：${clip(String(payload ?? ''), 200)}`
      } else {
        answer = DELEGATE
        note = '↩️ 已交回 Harness'
      }
      if (entry.messageId) {
        void editMessage(rt, chatId, entry.messageId, `${text}\n\n→ ${note}`, { reply_markup: { inline_keyboard: [] } })
      }
      resolvePromise(answer)
    }
    const timer = setTimeout(() => settle('delegate', null), rt.cfg.approvalTimeoutSeconds * 1000)
    if (typeof timer.unref === 'function') timer.unref()
    const onAbort = () => settle('delegate', null)
    if (request?.signal?.aborted) {
      settle('delegate', null)
      return
    }
    request?.signal?.addEventListener?.('abort', onAbort, { once: true })
    rt.pending.set(token, entry)
    void (async () => {
      try {
        const message = await tgCall(rt, 'sendMessage', {
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: rows },
        })
        entry.messageId = message?.message_id
      } catch (error) {
        rt.logger.warn(`telegram-control: 提问消息发送失败 ${error?.message || error}`)
        settle('delegate', null)
      }
    })()
  })
}

// ────────────────────── 主机电源控制（关机 / 重启 / 锁屏） ──────────────────────

const POWER_ACTIONS = {
  shutdown: { label: '关机', verbs: ['/s'] },
  reboot: { label: '重启', verbs: ['/r'] },
}

function decodeOutput(buffer) {
  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return buffer.toString('utf8')
  }
}

/** 跑一个短命令，只关心退出码与输出（GBK 解码，避免 Windows 中文乱码）。 */
async function runQuiet(file, args, timeoutMs = 15_000) {
  try {
    const result = await spawnCollect(file, args, undefined, timeoutMs)
    const text = (decodeOutputSafe(result.stdout) + decodeOutputSafe(result.stderr)).trim()
    return { ok: result.code === 0, code: result.code, out: text, timedOut: result.timedOut }
  } catch (error) {
    return { ok: false, code: -1, out: String(error?.message || error) }
  }
}

function decodeOutputSafe(buffer) {
  return Buffer.isBuffer(buffer) ? decodeOutput(buffer) : String(buffer ?? '')
}

/** shutdown.exe 的返回码翻译成人话。 */
function explainShutdown(result, action) {
  if (result.ok) return ''
  const map = {
    1190: `ℹ️ 已经有计划中的${action}了（发 /cancel 取消，或等它执行）`,
    1116: 'ℹ️ 当前没有计划中的关机或重启',
    5: '❌ 权限不足，无法执行电源操作',
    1: '❌ 参数不被系统接受',
    '-1': '❌ 无法启动 shutdown 命令',
  }
  return map[String(result.code)] || `❌ 执行失败（代码 ${result.code}）：${clip(result.out || '', 180)}`
}


/**
 * 组装 shutdown 调用。
 * `powerExec` 可以指向自定义可执行体；若给的是 .js/.mjs/.cjs 脚本，则用当前 Node 解释执行，
 * 方便替换成包装脚本（记录审计、改走别的主机、自定义电源策略）。
 */
function powerInvocation(rt, args) {
  const custom = rt.cfg.powerExec
  if (!custom) return { file: 'shutdown', args }
  if (/\.(mjs|cjs|js)$/i.test(custom)) return { file: process.execPath, args: [custom, ...args] }
  return { file: custom, args }
}

async function applyPower(rt, chatId, action, seconds) {
  const meta = POWER_ACTIONS[action]
  const call = powerInvocation(rt, [...meta.verbs, '/t', String(seconds)])
  const result = await runQuiet(call.file, call.args, 20_000)
  const now = Date.now()
  if (result.ok) {
    rt.power = { pending: { action, seconds, at: now }, last: { action, seconds, at: now, ok: true } }
    await sendText(rt, chatId, t(rt, 'power.scheduled', { seconds, action: t(rt, `action.${action}`) }))
    rt.logger.info(
      `telegram-control: ${t(rt, 'power.scheduledLog', { seconds, action: t(rt, `action.${action}`) })}`,
    )
    return
  }
  rt.power = { pending: null, last: { action, seconds, at: now, ok: false, code: result.code } }
  await sendText(rt, chatId, explainShutdown(result, t(rt, `action.${action}`)))
}

async function cancelPower(rt, chatId, notify = true) {
  const call = powerInvocation(rt, ['/a'])
  const result = await runQuiet(call.file, call.args, 20_000)
  const now = Date.now()
  let text
  if (result.ok) {
    rt.power = { pending: null, last: { action: 'cancel', at: now, ok: true } }
    text = t(rt, 'power.aborted')
    rt.logger.info(`telegram-control: ${t(rt, 'power.abortedLog')}`)
  } else {
    rt.power = { pending: null, last: { action: 'cancel', at: now, ok: false, code: result.code } }
    text = explainShutdown(result, t(rt, 'action.cancel'))
  }
  if (notify) await sendText(rt, chatId, text)
  return { ok: result.ok, text }
}

function powerStatusText(rt) {
  const up = process.uptime()
  const days = Math.floor(up / 86400)
  const hours = Math.floor((up % 86400) / 3600)
  const minutes = Math.floor((up % 3600) / 60)
  const totalGb = (totalmem() / 1024 ** 3).toFixed(1)
  const cores = cpus().length
  const pending = rt.power?.pending
  const pendingText = pending
    ? `${t(rt, `action.${pending.action}`)}（${Math.max(0, pending.seconds - Math.round((Date.now() - pending.at) / 1000))}s）`
    : t(rt, 'power.none')
  const last = rt.power?.last
  const lastText = last
    ? `${last.action === 'cancel' ? t(rt, 'action.cancel') : t(rt, `action.${last.action}`)} ${last.ok ? '✅' : `❌(${last.code})`} · ${formatTime(last.at)}`
    : t(rt, 'power.never')
  return t(rt, 'power.body', {
    host: hostname(),
    platform: process.platform,
    arch: process.arch,
    uptime: `${days}d ${hours}h ${minutes}m`,
    memory: totalGb,
    cores,
    allowed: rt.cfg.allowPower ? t(rt, 'power.allowed') : t(rt, 'power.denied'),
    pending: pendingText,
    last: lastText,
  })
}

async function lockStation(rt, chatId) {
  if (process.platform === 'win32') {
    const result = await runQuiet('rundll32.exe', ['user32.dll,LockWorkStation'], 10_000)
    await sendText(
      rt,
      chatId,
      result.ok ? t(rt, 'power.locked') : t(rt, 'power.lockFailed', { code: result.code, out: result.out }),
    )
    return
  }
  const result =
    process.platform === 'darwin'
      ? await runQuiet('pmset', ['displaysleepnow'], 10_000)
      : await runQuiet('loginctl', ['lock-session'], 10_000)
  await sendText(
    rt,
    chatId,
    result.ok ? t(rt, 'power.locked') : t(rt, 'power.lockFailed', { code: result.code, out: result.out }),
  )
}

async function suspendStation(rt, chatId, hibernate) {
  const label = t(rt, hibernate ? 'suspend.hibernate' : 'suspend.sleep')
  if (process.platform === 'win32') {
    const result = await runQuiet('rundll32.exe', ['powrprof.dll,SetSuspendState', hibernate ? '1,1,0' : '0,1,0'], 10_000)
    const hint = result.ok
      ? t(rt, 'power.suspended', { suspend: label })
      : `${t(rt, 'power.suspendFailed', { suspend: label, code: result.code, out: result.out || t(rt, 'power.suspendHint') })}\n${t(rt, 'power.hibernateOn')}`
    await sendText(rt, chatId, hint)
    return
  }
  const args = process.platform === 'darwin' ? ['sleepnow'] : [hibernate ? 'hibernate' : 'suspend']
  const bin = process.platform === 'darwin' ? 'pmset' : 'systemctl'
  const result = await runQuiet(bin, args, 10_000)
  await sendText(
    rt,
    chatId,
    result.ok
      ? t(rt, 'power.suspended', { suspend: label })
      : t(rt, 'power.suspendFailed', { suspend: label, code: result.code, out: result.out }),
  )
}

/** 解析秒数参数：now → 5，数字 → 原值，空 → 默认。返回 null 表示参数非法。 */
function parsePowerSeconds(raw, fallback) {
  const text = String(raw ?? '').trim().toLowerCase()
  if (text.length === 0) return fallback
  if (text === 'now' || text === '立即') return 5
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0 || value > 86_400) return null
  return Math.round(value)
}

async function powerCommand(rt, chat, action, args) {
  if (!rt.cfg.allowPower) {
    await sendText(rt, chat.id, t(rt, 'power.deniedHint'))
    return
  }
  const raw = String(args ?? '').trim()
  if (/^(cancel|abort|off|撤销|取消)$/i.test(raw)) {
    await cancelPower(rt, chat.id)
    return
  }
  const seconds = parsePowerSeconds(raw, rt.cfg.powerDefaultSeconds)
  if (seconds === null) {
    await sendText(rt, chat.id, t(rt, 'power.usage'))
    return
  }
  const meta = POWER_ACTIONS[action]
  const label = t(rt, `action.${action}`)
  if (seconds <= 10) {
    const token = randomUUID().slice(0, 8)
    rt.powerConfirm.set(token, { action, seconds, chatId: chat.id, at: Date.now() })
    await sendText(rt, chat.id, t(rt, 'power.confirm', { action: label, command: action, seconds }), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: t(rt, 'power.confirmYes', { action: label }), callback_data: `p:${token}:1` },
            { text: t(rt, 'power.confirmNo'), callback_data: `p:${token}:0` },
          ],
        ],
      },
    })
    return
  }
  await applyPower(rt, chat.id, action, seconds)
}

// ────────────────────────────── 命令实现 ──────────────────────────────

/**
 * Telegram 的命令菜单来源。
 *
 * 客户端只有在 `setMyCommands` 注册过之后，输入 `/` 才会弹候选列表；
 * 这里把插件真正支持的命令一次性注册到 default / 私聊 / 群聊三个作用域。
 */
const BOT_COMMANDS = [
  'start',
  'help',
  'menu',
  'myid',
  'status',
  'version',
  'sessions',
  'new',
  'use',
  'info',
  'cancel',
  'fork',
  'rename',
  'presets',
  'models',
  'model',
  'tools',
  'tool',
  'shell',
  'exec',
  'cd',
  'pwd',
  'ls',
  'read',
  'write',
  'approvals',
  'questions',
  'reasoning',
  'plugins',
  'plugin',
  'bundles',
  'install',
  'uninstall',
  'pause',
  'resume',
  'shutdown',
  'reboot',
  'power',
  'lock',
  'sleep',
  'lang',
]

let commandsInFlight = null

/** 注册命令菜单（幂等，重复调用只会覆盖同样的内容）。 */
async function registerBotCommands(rt, force = false) {
  if (commandsInFlight && !force) return commandsInFlight
  const commands = BOT_COMMANDS.map((command) => ({
    command,
    description: clip(t(rt, `menu.${command}`), 256),
  }))
  const shortDescription = t(rt, 'bot.shortDescription')
  const description = t(rt, 'bot.description')
  commandsInFlight = (async () => {
    let registered = 0
    for (const scope of [{ type: 'default' }, { type: 'all_private_chats' }, { type: 'all_group_chats' }]) {
      try {
        await tgCall(rt, 'setMyCommands', { commands, scope })
        registered = commands.length
      } catch (error) {
        rt.logger.warn(`telegram-control: setMyCommands(${scope.type}) 失败 ${error?.message || error}`)
      }
    }
    try {
      await tgCall(rt, 'setChatMenuButton', { menu_button: { type: 'commands' } })
    } catch (error) {
      rt.logger.warn(`telegram-control: setChatMenuButton 失败 ${error?.message || error}`)
    }
    try {
      await tgCall(rt, 'setMyShortDescription', { short_description: shortDescription })
      await tgCall(rt, 'setMyDescription', { description })
    } catch (error) {
      rt.logger.warn(`telegram-control: setMyDescription 失败 ${error?.message || error}`)
    }
    rt.botCommands = registered
    if (registered > 0) rt.logger.info(`telegram-control: 已注册 ${registered} 条命令菜单（${langOf(rt)}）`)
    return registered
  })().finally(() => {
    commandsInFlight = null
  })
  return commandsInFlight
}

/** 帮助文本按语言取。 */
function helpText(rt) {
  return t(rt, 'help.body')
}

async function runCommand(rt, chat, command, args) {
  switch (command) {
    case 'start':
    case 'help':
      rt.paused = false
      await sendText(rt, chat.id, helpText(rt))
      return
    case 'menu':
    case 'commands': {
      const count = await registerBotCommands(rt, true)
      await sendText(
        rt,
        chat.id,
        count > 0
          ? t(rt, 'menu.registered', { count })
          : t(rt, 'menu.failed'),
      )
      return
    }
    case 'myid':
      await sendText(
        rt,
        chat.id,
        t(rt, 'myid.body', {
          chatId: chat.id,
          userId: chat.userId ?? t(rt, 'myid.unknown'),
          session: chat.sessionId ?? t(rt, 'myid.unbound'),
        }),
      )
      return
    case 'lang': {
      const value = args.trim().toLowerCase()
      const list = langList()
      if (value.length === 0) {
        await sendText(rt, chat.id, t(rt, 'lang.current', { lang: langOf(rt), list: list.join(' / ') }))
        return
      }
      if (!isSupportedLang(value)) {
        await sendText(rt, chat.id, t(rt, 'lang.invalid', { lang: value, list: list.join(' / ') }))
        return
      }
      rt.cfg.lang = value
      await persistConfigPatch(rt, { lang: value })
      await registerBotCommands(rt, true)
      await sendText(rt, chat.id, t(rt, 'lang.set', { lang: value }))
      return
    }
    case 'status':
      await sendText(rt, chat.id, await statusText(rt, chat))
      return
    case 'version':
      await sendText(rt, chat.id, `dsh-telegram-control ${version}\nNode ${process.version}`)
      return
    case 'sessions': {
      const reply = await sessionsText(rt, chat)
      if (typeof reply === 'string') await sendText(rt, chat.id, reply)
      else await sendText(rt, chat.id, reply.text, reply.extra)
      return
    }
    case 'new': {
      const parsed = await parseNewArgs(rt, chat, args)
      stopFollower(chat)
      chat.sessionId = undefined
      chat.cursor = 0
      if (parsed.cwd) chat.cwd = parsed.cwd
      try {
        const sessionId = await ensureSession(rt, chat)
        let appliedTitle = ''
        if (parsed.title) {
          const controller = sessionController(rt)
          try {
            const value = controller ? await controller.rename({ sessionId, title: parsed.title }) : null
            appliedTitle = normalizeTitle(value?.title) || parsed.title
          } catch (error) {
            await sendText(rt, chat.id, t(rt, 'new.renameFailed', { error: error?.message || error }))
          }
        }
        ensureFollower(rt, chat)
        const lines = [t(rt, 'new.bound')]
        if (appliedTitle) lines.push(t(rt, 'new.title', { title: appliedTitle }))
        lines.push(sessionId, t(rt, 'new.cwd', { cwd: chatDirectory(rt, chat) }))
        if (!appliedTitle) lines.push('', t(rt, 'new.hint'))
        await sendText(rt, chat.id, lines.join('\n'))
      } catch (error) {
        await sendText(rt, chat.id, t(rt, 'new.failed', { error: error?.message || error }))
      }
      return
    }
    case 'use':
    case 'bind':
    case 'switch': {
      const resolved = await resolveSessionTarget(rt, chat, args)
      if (resolved?.candidates?.length) {
        await sendText(rt, chat.id, sessionCandidatesText(rt, resolved.candidates))
        return
      }
      if (!resolved?.sessionId) {
        await sendText(rt, chat.id, t(rt, 'use.usage'))
        return
      }
      stopFollower(chat)
      chat.sessionId = resolved.sessionId
      chat.cursor = 0
      scheduleSave(rt)
      ensureFollower(rt, chat)
      await sendText(
        rt,
        chat.id,
        `${t(rt, 'use.bound', { title: resolved.title || shortId(resolved.sessionId) })}\n${resolved.sessionId}`,
      )
      return
    }
    case 'info':
      await sendText(rt, chat.id, await infoText(rt, chat))
      return
    case 'shutdown':
    case 'poweroff':
      await powerCommand(rt, chat, 'shutdown', args)
      return
    case 'reboot':
    case 'restart':
      await powerCommand(rt, chat, 'reboot', args)
      return
    case 'power':
      await sendText(rt, chat.id, powerStatusText(rt))
      return
    case 'lock':
      if (!rt.cfg.allowPower) {
        await sendText(rt, chat.id, t(rt, 'power.deniedHint'))
        return
      }
      await lockStation(rt, chat.id)
      return
    case 'sleep':
    case 'hibernate':
      if (!rt.cfg.allowPower) {
        await sendText(rt, chat.id, t(rt, 'power.deniedHint'))
        return
      }
      await suspendStation(rt, chat.id, command === 'hibernate')
      return
    case 'cancel': {
      const notes = []
      const controller = sessionController(rt)
      if (controller && chat.sessionId) {
        try {
          controller.cancel({ sessionId: chat.sessionId })
          notes.push(t(rt, 'cancel.turn'))
        } catch (error) {
          notes.push(t(rt, 'cancel.turnFailed', { error: error?.message || error }))
        }
      }
      // 兼容老机器人的习惯：/cancel 同时撤销计划中的关机/重启
      const hadPending = Boolean(rt.power?.pending)
      if (hadPending && rt.cfg.allowPower) {
        const result = await cancelPower(rt, chat.id, false)
        notes.push(result.text)
        await sendText(rt, chat.id, notes.join('\n'))
        return
      }
      if (notes.length === 0) {
        await sendText(rt, chat.id, t(rt, 'cancel.nothing'))
        return
      }
      await sendText(rt, chat.id, notes.join('\n'))
      return
    }
    case 'fork': {
      const controller = sessionController(rt)
      if (!controller || !chat.sessionId) {
        await sendText(rt, chat.id, '当前没有绑定会话。')
        return
      }
      try {
        const value = await controller.fork({ sessionId: chat.sessionId })
        stopFollower(chat)
        chat.sessionId = value?.sessionId
        chat.cursor = 0
        scheduleSave(rt)
        ensureFollower(rt, chat)
        await sendText(rt, chat.id, `🌿 已分叉并绑定\n${chat.sessionId}`)
      } catch (error) {
        await sendText(rt, chat.id, `❌ 分叉失败：${error?.message || error}`)
      }
      return
    }
    case 'rename': {
      const controller = sessionController(rt)
      if (!controller || !chat.sessionId) {
        await sendText(rt, chat.id, '当前没有绑定会话。')
        return
      }
      const title = args.trim()
      if (title.length === 0) {
        await sendText(rt, chat.id, t(rt, 'rename.usage'))
        return
      }
      try {
        const value = await controller.rename({ sessionId: chat.sessionId, title })
        await sendText(rt, chat.id, t(rt, 'rename.done', { title: value?.title ?? title }))
      } catch (error) {
        await sendText(rt, chat.id, t(rt, 'rename.failed', { error: error?.message || error }))
      }
      return
    }
    case 'models':
      await sendText(rt, chat.id, await modelsText(rt))
      return
    case 'model': {
      const [provider, model] = args.trim().split(/\s+/)
      if (!provider || !model) {
        await sendText(rt, chat.id, '用法：/model <provider> <model>')
        return
      }
      const controller = sessionController(rt)
      if (!controller) {
        await sendText(rt, chat.id, 'sessionController 不可用。')
        return
      }
      try {
        const sessionId = await ensureSession(rt, chat)
        const value = await controller.selectModel({ sessionId, provider, model })
        await sendText(rt, chat.id, `🧠 已切换模型：${value?.selected?.provider ?? provider}/${value?.selected?.model ?? model}`)
      } catch (error) {
        await sendText(rt, chat.id, `❌ 切换失败：${error?.message || error}`)
      }
      return
    }
    case 'presets': {
      const registry = getService(rt, 'agentPresets')
      if (!registry) {
        await sendText(rt, chat.id, 'agentPresets 不可用。')
        return
      }
      try {
        const list = await registry.list()
        const lines = ['🎛 Agent presets：']
        for (const preset of list.slice(0, 40)) {
          lines.push(`• ${preset?.id ?? preset?.name ?? JSON.stringify(preset).slice(0, 60)}`)
        }
        lines.push('', `当前默认：${rt.cfg.agentPreset || '（未设置）'}`)
        await sendText(rt, chat.id, lines.join('\n'))
      } catch (error) {
        await sendText(rt, chat.id, `❌ 读取失败：${error?.message || error}`)
      }
      return
    }
    case 'tools':
      await sendText(rt, chat.id, await toolsText(rt, chat))
      return
    case 'tool':
      await runTool(rt, chat, args)
      return
    case 'shell':
    case 'exec':
      await runShellCommand(rt, chat, args)
      return
    case 'cd': {
      const target = resolvePath(rt, chat, args)
      try {
        const info = await stat(target)
        if (!info.isDirectory()) {
          await sendText(rt, chat.id, `不是目录：${target}`)
          return
        }
      } catch (error) {
        await sendText(rt, chat.id, `目录不可用：${target}（${error?.message || error}）`)
        return
      }
      chat.cwd = target
      scheduleSave(rt)
      await sendText(rt, chat.id, `📁 当前目录：${target}`)
      return
    }
    case 'pwd':
      await sendText(rt, chat.id, `📁 ${chatDirectory(rt, chat)}`)
      return
    case 'ls':
      await listDirectory(rt, chat, args)
      return
    case 'read':
    case 'cat':
      await readTextFile(rt, chat, args)
      return
    case 'write':
      await writeTextFile(rt, chat, args)
      return
    case 'approvals': {
      const value = args.trim().toLowerCase()
      if (value !== 'on' && value !== 'off') {
        await sendText(rt, chat.id, t(rt, 'approvals.current', { state: onOff(rt.approvalsEnabled) }))
        return
      }
      rt.approvalsEnabled = value === 'on'
      rt.cfg.answerApprovals = rt.approvalsEnabled
      await persistConfigPatch(rt, { answerApprovals: rt.approvalsEnabled })
      await sendText(rt, chat.id, t(rt, 'approvals.set', { state: onOff(rt.approvalsEnabled) }))
      return
    }
    case 'questions': {
      const value = args.trim().toLowerCase()
      if (value !== 'on' && value !== 'off') {
        await sendText(rt, chat.id, t(rt, 'questions.current', { state: onOff(rt.questionsEnabled) }))
        return
      }
      rt.questionsEnabled = value === 'on'
      rt.cfg.answerQuestions = rt.questionsEnabled
      await persistConfigPatch(rt, { answerQuestions: rt.questionsEnabled })
      await sendText(rt, chat.id, t(rt, 'questions.set', { state: onOff(rt.questionsEnabled) }))
      return
    }
    case 'plugins':
      await sendText(rt, chat.id, await pluginsText(rt))
      return
    case 'plugin':
      await togglePlugin(rt, chat, args)
      return
    case 'bundles':
      await sendText(rt, chat.id, await bundlesText(rt))
      return
    case 'install':
      await installBundle(rt, chat, args)
      return
    case 'uninstall':
      await removeBundle(rt, chat, args)
      return
    case 'pause':
      rt.paused = true
      await sendText(rt, chat.id, '⏸ 已暂停（/resume 恢复）')
      return
    case 'resume':
      rt.paused = false
      await sendText(rt, chat.id, '▶️ 已恢复')
      return
    case 'pause':
      rt.paused = true
      await sendText(rt, chat.id, t(rt, 'pause.on'))
      return
    case 'resume':
      rt.paused = false
      await sendText(rt, chat.id, t(rt, 'pause.off'))
      return
    case 'reasoning':
    case 'think': {
      const value = args.trim().toLowerCase()
      if (value !== 'on' && value !== 'off') {
        await sendText(rt, chat.id, t(rt, 'reasoning.current', { state: onOff(rt.cfg.forwardReasoning) }))
        return
      }
      rt.cfg.forwardReasoning = value === 'on'
      await persistConfigPatch(rt, { forwardReasoning: rt.cfg.forwardReasoning })
      await sendText(rt, chat.id, t(rt, rt.cfg.forwardReasoning ? 'reasoning.on' : 'reasoning.off'))
      return
    }
    default:
      await sendText(rt, chat.id, `Unknown command /${command}\n\n${helpText(rt)}`)
  }
}

async function statusText(rt, chat) {
  const controller = sessionController(rt)
  let liveCount = 0
  let running = 0
  if (controller) {
    try {
      const value = await controller.list({}, rt.ac.signal)
      const items = Array.isArray(value?.items) ? value.items : []
      liveCount = items.length
      running = items.filter((item) => item?.running === true).length
    } catch {
      /* ignore */
    }
  }
  const session = chat.sessionId
    ? `${(await sessionTitleOf(rt, chat.sessionId)) || t(rt, 'status.untitled')} · ${shortId(chat.sessionId)}`
    : t(rt, 'status.unbound')
  const pending = rt.power?.pending
  return t(rt, 'status.body', {
    state: rt.paused ? t(rt, 'status.paused') : t(rt, 'status.running'),
    version,
    bot: rt.botInfo?.username ? `@${rt.botInfo.username}` : t(rt, 'status.unknownBot'),
    commands: rt.botCommands || 0,
    commandsHint: rt.botCommands ? '' : t(rt, 'status.commandsHint'),
    count: liveCount,
    running,
    session,
    cwd: chatDirectory(rt, chat),
    approvals: onOff(rt.approvalsEnabled),
    questions: onOff(rt.questionsEnabled),
    reasoning: onOff(rt.cfg.forwardReasoning),
    power: rt.cfg.allowPower ? t(rt, 'status.powerAllowed') : t(rt, 'status.powerDenied'),
    pendingPower: pending ? t(rt, `action.${pending.action}`) : t(rt, 'status.none'),
    lang: langOf(rt),
    chats: JSON.stringify(rt.cfg.allowedChatIds),
    users: JSON.stringify(rt.cfg.allowedUserIds),
    since: formatTime(rt.startedAt),
    updates: rt.stats.updates,
    messages: rt.stats.messages,
    errors: rt.stats.errors,
    proxy: rt.cfg.proxyUrl || t(rt, 'status.direct'),
    configUrl: rt.cfg.configPort > 0 ? `http://127.0.0.1:${rt.cfg.configPort}/` : t(rt, 'status.configClosed'),
    configPath: join(dshHome(), 'telegram-control.json'),
    statusPath: rt.statusPath,
  })
}

async function sessionsText(rt, chat) {
  const controller = sessionController(rt)
  if (!controller) return t(rt, 'sessions.unavailable')
  try {
    const all = await sessionItems(rt)
    if (!all) return t(rt, 'sessions.unavailable')
    const items = all.slice(0, 25)
    if (items.length === 0) return t(rt, 'sessions.empty')
    chat.lastList = items.map((item) => ({ sessionId: item.sessionId, title: item.title }))
    const lines = [t(rt, 'sessions.header')]
    items.forEach((item, index) => {
      const marks = [item.running ? '▶️' : '·', item.sessionId === chat.sessionId ? '📌' : '']
        .filter(Boolean)
        .join('')
      lines.push(`${index + 1}. ${marks} ${item.title || t(rt, 'sessions.untitled')}  ${shortId(item.sessionId)}`)
      const detail = [item.cwd, formatTime(item.updatedAt)].filter((v) => typeof v === 'string' && v.length > 0)
      if (detail.length > 0) lines.push(`    ${detail.join(' · ')}`)
    })
    const rows = items.slice(0, 12).map((item, index) => {
      const label = `${item.sessionId === chat.sessionId ? '📌 ' : ''}${index + 1}. ${item.title || shortId(item.sessionId)}`
      return [{ text: label.slice(0, 60), callback_data: `s:${index + 1}` }]
    })
    const extra = rows.length > 0 ? { reply_markup: { inline_keyboard: rows } } : undefined
    return { text: lines.join('\n'), extra }
  } catch (error) {
    return `❌ 读取会话失败：${error?.message || error}`
  }
}

function normalizeTitle(value) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''
  return text.length > 0 ? text.slice(0, 120) : ''
}

async function pathExists(path) {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

/** 拉一份会话列表（带标题），供 /sessions /use 解析共用。 */
async function sessionItems(rt) {
  const controller = sessionController(rt)
  if (!controller) return null
  const value = await controller.list({}, rt.ac.signal)
  const items = Array.isArray(value?.items) ? value.items : []
  return items.map((item) => ({
    sessionId: String(item?.sessionId ?? ''),
    title: normalizeTitle(item?.projections?.values?.title),
    cwd: typeof item?.cwd === 'string' ? item.cwd : '',
    running: item?.running === true,
    updatedAt: item?.updatedAt,
  }))
}

/**
 * 解析会话引用：序号（1 / #1）、完整或前缀 sessionId、标题（精确 → 模糊）。
 * @returns {Promise<{sessionId?:string,title?:string,candidates?:object[],error?:string}>}
 */
async function resolveSessionTarget(rt, chat, args) {
  const raw = String(args ?? '').trim().replace(/^#/, '')
  if (raw.length === 0) return { error: 'empty' }
  let items = null
  try {
    items = await sessionItems(rt)
  } catch {
    items = null
  }
  const source = Array.isArray(items) ? items : []
  if (source.length > 0) {
    chat.lastList = source.map((item) => ({ sessionId: item.sessionId, title: item.title }))
  }
  const index = Number(raw)
  if (Number.isInteger(index) && index > 0 && index <= source.length) {
    const hit = source[index - 1]
    return { sessionId: hit.sessionId, title: hit.title }
  }
  const exactId = source.filter((item) => item.sessionId === raw)
  if (exactId.length === 1) return { sessionId: exactId[0].sessionId, title: exactId[0].title }
  const lower = raw.toLowerCase()
  const exactTitle = source.filter((item) => item.title && item.title.toLowerCase() === lower)
  if (exactTitle.length === 1) return { sessionId: exactTitle[0].sessionId, title: exactTitle[0].title }
  const fuzzy = source.filter((item) => item.title && item.title.toLowerCase().includes(lower))
  if (fuzzy.length === 1) return { sessionId: fuzzy[0].sessionId, title: fuzzy[0].title }
  const prefix = raw.length >= 4 ? source.filter((item) => item.sessionId.startsWith(raw)) : []
  if (prefix.length === 1) return { sessionId: prefix[0].sessionId, title: prefix[0].title }
  if (fuzzy.length > 1 || prefix.length > 1) {
    return { candidates: (fuzzy.length > 1 ? fuzzy : prefix).slice(0, 8) }
  }
  if (/^[A-Za-z0-9_-]{6,}$/.test(raw)) return { sessionId: raw }
  return { error: 'not-found' }
}

/**
 * 解析 /new 的参数：`[目录] [| 标题]`。
 * 没有 `|` 时：像路径（含分隔符或目录存在）就当目录，否则当标题。
 */
async function parseNewArgs(rt, chat, args) {
  const raw = String(args ?? '').trim()
  if (raw.length === 0) return {}
  const bar = raw.indexOf('|')
  if (bar >= 0) {
    const dir = raw.slice(0, bar).trim()
    const title = normalizeTitle(raw.slice(bar + 1))
    const parsed = { title }
    if (dir.length > 0) parsed.cwd = resolvePath(rt, chat, dir)
    return parsed
  }
  const candidate = resolvePath(rt, chat, raw)
  if (/[\\/]/.test(raw) || (await pathExists(candidate))) return { cwd: candidate }
  return { title: normalizeTitle(raw) }
}

function sessionCandidatesText(rt, candidates) {
  const lines = [t(rt, 'use.candidates')]
  candidates.forEach((item) => {
    lines.push(`· ${shortId(item.sessionId)}${item.title ? ` ${item.title}` : ''}`)
  })
  lines.push('', t(rt, 'sessions.header'))
  return lines.join('\n')
}

async function sessionTitleOf(rt, sessionId) {
  if (!sessionId) return ''
  try {
    const items = await sessionItems(rt)
    if (!Array.isArray(items)) return ''
    const hit = items.find((item) => item.sessionId === sessionId)
    return hit?.title ?? ''
  } catch {
    return ''
  }
}

async function infoText(rt, chat) {
  const controller = sessionController(rt)
  if (!controller || !chat.sessionId) return t(rt, 'info.noSession')
  try {
    const [inspection, items] = await Promise.all([
      controller.inspect(chat.sessionId, rt.ac.signal),
      sessionItems(rt).catch(() => null),
    ])
    const events = Array.isArray(inspection?.events) ? inspection.events : []
    const meta = inspection?.meta ?? {}
    const listed = Array.isArray(items) ? items.find((item) => item.sessionId === chat.sessionId) : null
    const title = normalizeTitle(meta?.title) || listed?.title || ''
    const tail = events.slice(-5).map((event) => `${event?.seq}:${event?.type}`)
    return t(rt, 'info.body', {
      title: title || t(rt, 'info.untitled'),
      id: chat.sessionId,
      cwd: meta?.cwd ?? listed?.cwd ?? chatDirectory(rt, chat),
      preset: meta?.agentPreset ?? 'default',
      state: `${listed?.running ? t(rt, 'info.running') : t(rt, 'info.idle')}${
        listed?.updatedAt ? t(rt, 'info.updated', { time: formatTime(listed.updatedAt) }) : ''
      }`,
      created: formatTime(meta?.createdAt),
      events: events.length,
      tail: tail.join(' → ') || t(rt, 'info.emptyTail'),
    })
  } catch (error) {
    return t(rt, 'info.failed', { error: error?.message || error })
  }
}

async function modelsText(rt) {
  const controller = sessionController(rt)
  if (!controller) return 'sessionController 不可用。'
  try {
    const catalog = await controller.modelCatalog()
    const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
    const lines = ['🧠 可用模型：']
    for (const group of groups) {
      lines.push(`【${group?.name ?? group?.id ?? 'provider'}】`)
      for (const model of (group?.models ?? []).slice(0, 20)) {
        lines.push(`  /model ${group?.id ?? ''} ${model?.id ?? ''}`)
      }
    }
    if (catalog?.default) lines.push('', `默认：${catalog.default.provider}/${catalog.default.model}`)
    return clip(lines.join('\n'), 12_000)
  } catch (error) {
    return `❌ 读取模型目录失败：${error?.message || error}`
  }
}

async function toolsText(rt, chat) {
  const tools = getService(rt, 'tools')
  if (!tools) return 'tools 服务不可用。'
  try {
    const agent = chat.sessionId ? getService(rt, 'agents')?.get(chat.sessionId) : undefined
    const schemas = tools.schemas(agent) ?? []
    const names = schemas.map((schema) => schema.name).sort()
    return clip(['🧰 可用工具（/tool <名称> {json}）：', ...names.map((n) => `• ${n}`)].join('\n'), 12_000)
  } catch (error) {
    return `❌ 读取工具失败：${error?.message || error}`
  }
}

async function runTool(rt, chat, args) {
  if (!rt.cfg.allowTools) {
    await sendText(rt, chat.id, '当前配置禁止直接调用工具（allowTools=false）。')
    return
  }
  const trimmed = args.trim()
  if (trimmed.length === 0) {
    await sendText(rt, chat.id, '用法：/tool <名称> [JSON 参数]')
    return
  }
  const space = trimmed.search(/\s/)
  const toolName = (space < 0 ? trimmed : trimmed.slice(0, space)).slice(0, MAX_TOOL_NAME)
  const rawArgs = space < 0 ? '' : trimmed.slice(space + 1).trim()
  let parsedArgs = {}
  if (rawArgs.length > 0) {
    try {
      parsedArgs = JSON.parse(rawArgs)
    } catch (error) {
      await sendText(rt, chat.id, `❌ 参数不是合法 JSON：${error?.message || error}`)
      return
    }
  }
  const tools = getService(rt, 'tools')
  if (!tools) {
    await sendText(rt, chat.id, 'tools 服务不可用。')
    return
  }
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), rt.cfg.commandTimeoutSeconds * 1000)
  try {
    const agent = chat.sessionId ? getService(rt, 'agents')?.get(chat.sessionId) : undefined
    const result = await tools.execute({
      callId: randomUUID(),
      name: toolName,
      arguments: parsedArgs,
      agent,
      signal: ac.signal,
    })
    await sendText(rt, chat.id, formatToolResult(toolName, result))
  } catch (error) {
    await sendText(rt, chat.id, `❌ 工具执行异常：${error?.message || error}`)
  } finally {
    clearTimeout(timer)
  }
}

function formatToolResult(toolName, result) {
  if (result?.isError === true) {
    return `❌ ${toolName} 失败：${result?.error?.message ?? result?.error?.code ?? '未知错误'}`
  }
  const text = blocksText(result?.content)
  if (text.length > 0) return clip(`🧰 ${toolName}\n${text}`, 12_000)
  try {
    return clip(`🧰 ${toolName}\n${JSON.stringify(result?.value ?? null, null, 2)}`, 12_000)
  } catch {
    return `🧰 ${toolName}\n（结果无法序列化）`
  }
}

function spawnCollect(file, args, cwd, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child
    try {
      child = spawn(file, args, { cwd, windowsHide: true, env: process.env })
    } catch (error) {
      rejectPromise(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    const startedAt = Date.now()
    const append = (target, chunk) => {
      if (target.length >= OUTPUT_CAP) {
        truncated = true
        return target
      }
      const text = chunk.toString('utf8')
      const remaining = OUTPUT_CAP - target.length
      if (text.length > remaining) {
        truncated = true
        return target + text.slice(0, remaining)
      }
      return target + text
    }
    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk)
    })
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolvePromise({ code, signal, stdout, stderr, truncated, timedOut, elapsedMs: Date.now() - startedAt })
    })
  })
}

async function runShell(rt, command, cwd) {
  const timeoutMs = rt.cfg.commandTimeoutSeconds * 1000
  const candidates = []
  if (rt.cfg.shellPath) {
    candidates.push(
      process.platform === 'win32'
        ? { file: rt.cfg.shellPath, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] }
        : { file: rt.cfg.shellPath, args: ['-lc', command] },
    )
  } else if (process.platform === 'win32') {
    candidates.push({ file: 'pwsh.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] })
    candidates.push({ file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] })
    candidates.push({ file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] })
  } else {
    candidates.push({ file: '/bin/bash', args: ['-lc', command] })
  }
  let lastError
  for (const candidate of candidates) {
    try {
      return await spawnCollect(candidate.file, candidate.args, cwd, timeoutMs)
    } catch (error) {
      lastError = error
      if (error?.code === 'ENOENT') continue
      throw error
    }
  }
  throw lastError ?? new Error('找不到可用的 shell')
}

async function runShellCommand(rt, chat, command) {
  if (!rt.cfg.allowShell) {
    await sendText(rt, chat.id, '当前配置禁止 shell 执行（allowShell=false）。')
    return
  }
  const value = command.trim()
  if (value.length === 0) {
    await sendText(rt, chat.id, '用法：/shell <命令>')
    return
  }
  const cwd = chatDirectory(rt, chat)
  await sendTyping(rt, chat.id)
  try {
    const result = await runShell(rt, value, cwd)
    const lines = [`$ ${value}`, `# cwd: ${cwd}`]
    if (result.stdout.trim().length > 0) lines.push('── stdout ──', clip(result.stdout.trimEnd(), 8000))
    if (result.stderr.trim().length > 0) lines.push('── stderr ──', clip(result.stderr.trimEnd(), 4000))
    if (result.stdout.trim().length === 0 && result.stderr.trim().length === 0) lines.push('（无输出）')
    const status = result.timedOut
      ? `⏱ 超时（${rt.cfg.commandTimeoutSeconds}s）`
      : `exit=${result.code ?? 'null'}${result.signal ? ` signal=${result.signal}` : ''}`
    lines.push(`── ${status} · ${(result.elapsedMs / 1000).toFixed(2)}s${result.truncated ? ' · 输出已截断' : ''}`)
    await sendText(rt, chat.id, lines.join('\n'))
  } catch (error) {
    await sendText(rt, chat.id, `❌ 执行失败：${error?.message || error}`)
  }
}

async function listDirectory(rt, chat, args) {
  if (!rt.cfg.allowFs) {
    await sendText(rt, chat.id, '当前配置禁止文件操作（allowFs=false）。')
    return
  }
  const target = resolvePath(rt, chat, args.split(/\s+/)[0] ?? '')
  try {
    const entries = await readdir(target, { withFileTypes: true })
    const rows = []
    for (const entry of entries.slice(0, 100)) {
      if (entry.name === '.' || entry.name === '..') continue
      let size = ''
      if (entry.isFile()) {
        try {
          const info = await stat(join(target, entry.name))
          size = ` ${formatBytes(info.size)}`
        } catch {
          size = ''
        }
      }
      rows.push(`${entry.isDirectory() ? '📁' : '📄'} ${entry.name}${size}`)
    }
    rows.sort((a, b) => (a.startsWith('📁') === b.startsWith('📁') ? a.localeCompare(b) : a.startsWith('📁') ? -1 : 1))
    await sendText(
      rt,
      chat.id,
      clip([`📂 ${target}`, ...(rows.length > 0 ? rows : ['（空目录）'])].join('\n'), 12_000),
    )
  } catch (error) {
    await sendText(rt, chat.id, `❌ 列目录失败：${error?.message || error}`)
  }
}

function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value)) return ''
  if (value < 1024) return `${value}B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}K`
  return `${(value / 1024 / 1024).toFixed(1)}M`
}

async function readTextFile(rt, chat, args) {
  if (!rt.cfg.allowFs) {
    await sendText(rt, chat.id, '当前配置禁止文件操作（allowFs=false）。')
    return
  }
  const target = resolvePath(rt, chat, args.split(/\s+/)[0] ?? '')
  try {
    const info = await stat(target)
    if (info.isDirectory()) {
      await sendText(rt, chat.id, `${target} 是目录，改用 /ls`)
      return
    }
    if (info.size > 2_000_000) {
      await sendText(rt, chat.id, `文件过大（${formatBytes(info.size)}），拒绝直接读取。`)
      return
    }
    const text = await readFile(target, 'utf8')
    const lines = text.split('\n').length
    await sendText(rt, chat.id, clip(`📄 ${target}（${lines} 行）\n\n${text}`, 12_000))
  } catch (error) {
    await sendText(rt, chat.id, `❌ 读取失败：${error?.message || error}`)
  }
}

async function writeTextFile(rt, chat, args) {
  if (!rt.cfg.allowFs) {
    await sendText(rt, chat.id, '当前配置禁止文件操作（allowFs=false）。')
    return
  }
  const newline = args.indexOf('\n')
  if (newline < 0) {
    await sendText(rt, chat.id, '用法：\n/write <路径>\n<文件内容>')
    return
  }
  const target = resolvePath(rt, chat, args.slice(0, newline))
  const content = args.slice(newline + 1)
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
    await sendText(rt, chat.id, `💾 已写入 ${target}（${content.length} 字符）`)
  } catch (error) {
    await sendText(rt, chat.id, `❌ 写入失败：${error?.message || error}`)
  }
}

async function pluginsText(rt) {
  const manager = getService(rt, 'pluginManager')
  if (!manager) return 'pluginManager 不可用。'
  try {
    const list = await manager.listPlugins()
    const lines = ['🧩 已安装插件（/plugin enable|disable <patchId>）：']
    for (const plugin of list.slice(0, 60)) {
      const label = plugin?.name ?? plugin?.packageName ?? plugin?.id ?? '?'
      const patchId = plugin?.patchId ?? plugin?.id ?? ''
      const enabled = plugin?.enabled !== false && plugin?.disabled !== true
      lines.push(`${enabled ? '✅' : '⏸'} ${label}${patchId ? ` [${patchId}]` : ''}`)
    }
    return clip(lines.join('\n'), 12_000)
  } catch (error) {
    return `❌ 读取插件列表失败：${error?.message || error}`
  }
}

async function togglePlugin(rt, chat, args) {
  const manager = getService(rt, 'pluginManager')
  if (!manager) {
    await sendText(rt, chat.id, 'pluginManager 不可用。')
    return
  }
  const [action, id] = args.trim().split(/\s+/)
  if (!action || !id) {
    await sendText(rt, chat.id, '用法：/plugin enable|disable <patchId>')
    return
  }
  if (action !== 'enable' && action !== 'disable') {
    await sendText(rt, chat.id, '只支持 enable 或 disable。')
    return
  }
  try {
    const result = await manager.setPluginEnabled(id, action === 'enable')
    await sendText(rt, chat.id, describeChange(result, `插件 ${id} → ${action}`))
  } catch (error) {
    await sendText(rt, chat.id, `❌ 操作失败：${error?.message || error}`)
  }
}

async function bundlesText(rt) {
  const manager = getService(rt, 'pluginManager')
  if (!manager) return 'pluginManager 不可用。'
  try {
    const list = await manager.listBundles()
    const lines = ['📦 Bundle：']
    for (const bundle of list.slice(0, 60)) {
      lines.push(
        `${bundle?.enabled === false ? '⏸' : '✅'} ${bundle?.name ?? '?'}${bundle?.version ? ` v${bundle.version}` : ''}`,
      )
    }
    return clip(lines.join('\n'), 12_000)
  } catch (error) {
    return `❌ 读取 bundle 失败：${error?.message || error}`
  }
}

function describeChange(result, label) {
  if (!result) return `${label}\n结果：无返回`
  const lines = [label, `应用：${result.application ?? 'unknown'}`]
  if (result.changed === false) lines.push('状态：无变化')
  if (result.restartReason) lines.push(`重启原因：${result.restartReason}`)
  if (result.error?.message) lines.push(`错误：${result.error.message}`)
  if (Array.isArray(result.warnings) && result.warnings.length > 0) lines.push(`警告：${result.warnings.join('; ')}`)
  if (Array.isArray(result.pendingBuilds) && result.pendingBuilds.length > 0) {
    lines.push(`待批准构建：${result.pendingBuilds.join(', ')}`)
  }
  return lines.join('\n')
}

async function installBundle(rt, chat, args) {
  const manager = getService(rt, 'pluginManager')
  if (!manager) {
    await sendText(rt, chat.id, 'pluginManager 不可用。')
    return
  }
  const spec = args.trim()
  if (spec.length === 0) {
    await sendText(rt, chat.id, '用法：/install <npm 包名|目录路径>')
    return
  }
  await sendText(rt, chat.id, `⏳ 正在安装：${spec}`)
  try {
    const result = await manager.installBundle(spec)
    await sendText(rt, chat.id, describeChange(result, `📦 安装 ${spec}`))
  } catch (error) {
    await sendText(rt, chat.id, `❌ 安装失败：${error?.message || error}`)
  }
}

async function removeBundle(rt, chat, args) {
  const manager = getService(rt, 'pluginManager')
  if (!manager) {
    await sendText(rt, chat.id, 'pluginManager 不可用。')
    return
  }
  const name = args.trim()
  if (name.length === 0) {
    await sendText(rt, chat.id, '用法：/uninstall <bundle 名称>')
    return
  }
  try {
    const result = await manager.removeBundle(name)
    await sendText(rt, chat.id, describeChange(result, `🗑 卸载 ${name}`))
  } catch (error) {
    await sendText(rt, chat.id, `❌ 卸载失败：${error?.message || error}`)
  }
}

// ────────────────────────────── 配置热加载 ──────────────────────────────

async function ensureTemplateConfig(configPath, staticConfig) {
  try {
    await stat(configPath)
    return
  } catch {
    /* 文件不存在时写入模板 */
  }
  const staticToken = typeof staticConfig?.botToken === 'string' ? staticConfig.botToken.trim() : ''
  if (staticToken.length > 0) return
  try {
    await writeJsonFile(configPath, {
      _readme:
        '把 BotFather 给的 token 填到 botToken；allowedUserIds / allowedChatIds 至少填一个，否则所有消息都会被拒绝。保存后 5 秒内自动生效，无需重启 DSH。',
      botToken: '',
      allowedUserIds: [],
      allowedChatIds: [],
      workingDirectory: '',
      agentPreset: '',
      lang: 'zh',
      thinkingStatus: 'typing',
      answerApprovals: false,
      answerQuestions: false,
    })
  } catch {
    /* ignore */
  }
}

async function supervise(ctx, staticConfig, holder, signal, logger) {
  const configPath = join(dshHome(), 'telegram-control.json')
  const statePath = join(dshHome(), 'telegram-control-state.json')
  const statusPath = join(dshHome(), 'telegram-control-status.json')
  await ensureTemplateConfig(configPath, staticConfig)
  let signature = null
  let announcedMissing = false
  const csrf = randomUUID()
  let configServer = null
  let configServerPort = -1

  while (!signal.aborted) {
    let fileConfig = null
    try {
      fileConfig = await readJsonFile(configPath)
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        logger.warn(`telegram-control: 读取 ${configPath} 失败 ${error?.message || error}`)
      }
    }
    const cfg = normalizeConfig(staticConfig, fileConfig)
    if (cfg.proxyUrl === 'auto') cfg.proxyUrl = detectSystemProxy()

    if (cfg.configPort > 0 && (!configServer || configServerPort !== cfg.configPort)) {
      if (configServer) {
        await configServer.close().catch(() => {})
        configServer = null
      }
      configServerPort = cfg.configPort
      const candidate = startConfigServer({ port: cfg.configPort, configPath, statusPath, csrf, logger })
      try {
        await candidate.listen()
        configServer = candidate
        logger.info(`telegram-control: 配置页已启动 ${candidate.url}`)
      } catch (error) {
        configServerPort = -1
        logger.warn(`telegram-control: 配置页端口 ${cfg.configPort} 启动失败 ${error?.message || error}`)
      }
    } else if (cfg.configPort === 0 && configServer) {
      await configServer.close().catch(() => {})
      configServer = null
      configServerPort = -1
      logger.info('telegram-control: 配置页已关闭')
    }
    const configUrl = configServer?.url ?? null

    const nextSignature = JSON.stringify({
      token: cfg.botToken,
      apiBaseUrl: cfg.apiBaseUrl,
      proxyUrl: cfg.proxyUrl,
      pollTimeoutSeconds: cfg.pollTimeoutSeconds,
    })
    const current = holder.rt

    if (!cfg.enabled || cfg.botToken.length === 0) {
      if (current) {
        await current.stop()
        holder.rt = null
        signature = null
        logger.info('telegram-control: 已停止（缺少 botToken 或已禁用）')
      } else if (!announcedMissing) {
        announcedMissing = true
        logger.info(
          `telegram-control: 等待 botToken —— 写入 ${configPath} 的 botToken 与 allowedUserIds 后自动启动`,
        )
      }
      await writeStatus(null, cfg.enabled ? 'waiting-token' : 'disabled', { configPath, configUrl })
    } else if (!current || signature !== nextSignature) {
      if (current) await current.stop()
      const rt = createRuntime(ctx, cfg, logger, statePath)
      try {
        await rt.start()
        holder.rt = rt
        signature = nextSignature
        announcedMissing = false
        logger.info(`telegram-control: Telegram 轮询已启动（代理：${cfg.proxyUrl || '直连'}）`)
        await writeStatus(rt, 'running', { configPath, configUrl })
      } catch (error) {
        logger.error(`telegram-control: 启动失败 ${error?.stack || error?.message || error}`)
        await rt.stop().catch(() => {})
        holder.rt = null
        await writeStatus(null, 'error', { configPath, configUrl, error: String(error?.message || error) })
      }
    } else {
      current.cfg = cfg
      current.approvalsEnabled = cfg.answerApprovals
      current.questionsEnabled = cfg.answerQuestions
      const state = current.ac.signal.aborted ? 'stopped' : 'running'
      await writeStatus(current, current.stats.lastError ? 'degraded' : state, { configPath, configUrl })
    }

    await sleep(cfg.reloadSeconds * 1000, signal)
  }

  if (holder.rt) {
    await holder.rt.stop().catch(() => {})
    holder.rt = null
  }
  if (configServer) {
    await configServer.close().catch(() => {})
    configServer = null
  }
  await writeStatus(null, 'stopped', { configPath })
}

// ────────────────────────────── Cordis 插件入口 ──────────────────────────────

/**
 * Host 插件入口。
 * @param ctx Cordis 上下文。
 * @param config 插件行配置（可为空对象）。
 */
export function apply(ctx, config) {
  const logger = safeLogger(ctx)
  const holder = { rt: null }
  const staticConfig = config && typeof config === 'object' ? config : {}

  ctx.effect(() => {
    const ac = new AbortController()
    void supervise(ctx, staticConfig, holder, ac.signal, logger).catch((error) => {
      logger.error(`telegram-control: 监督循环异常 ${error?.stack || error?.message || error}`)
    })

    const offApproval =
      typeof ctx.on === 'function'
        ? ctx.on('approval/request', (request, next) => {
            const rt = holder.rt
            if (!rt) return next()
            return approvalBridge(rt, request, next)
          })
        : undefined

    const offQuestions =
      typeof ctx.on === 'function'
        ? ctx.on('user-questions/request', (request, next) => {
            const rt = holder.rt
            if (!rt) return next()
            return questionBridge(rt, request, next)
          })
        : undefined

    const offError =
      typeof ctx.on === 'function'
        ? ctx.on('agent/error', (payload) => {
            const rt = holder.rt
            if (!rt) return
            const chatId = chatIdForSession(rt, payload?.agent?.id)
            if (chatId === undefined) return
            const message = payload?.error?.message ?? String(payload?.error ?? '未知错误')
            void sendText(rt, chatId, `❌ Agent 错误：${clip(message, 800)}`)
          })
        : undefined

    return () => {
      ac.abort()
      offApproval?.()
      offQuestions?.()
      offError?.()
      if (holder.rt) {
        const rt = holder.rt
        holder.rt = null
        void rt.stop().catch(() => {})
      }
    }
  })
}
