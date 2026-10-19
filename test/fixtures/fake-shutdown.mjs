#!/usr/bin/env node
/**
 * 假的 shutdown 可执行体，供离线测试使用。
 *
 * 行为：
 *   /s /t N  → 打印 scheduled-shutdown:N，退出码 FAKE_SHUTDOWN_CODE（默认 0）
 *   /r /t N  → 打印 scheduled-reboot:N
 *   /a       → 打印 abort-shutdown，退出码 FAKE_SHUTDOWN_ABORT_CODE（默认 0）
 *
 * 另外把收到的参数以 JSON 逐行追加到 FAKE_SHUTDOWN_LOG（若设置），方便断言调用序列。
 */

import { appendFileSync } from 'node:fs'

const args = process.argv.slice(2)
const log = process.env.FAKE_SHUTDOWN_LOG

if (log) {
  try {
    appendFileSync(log, `${JSON.stringify(args)}\n`, 'utf8')
  } catch {
    /* 日志失败不影响行为 */
  }
}

const has = (flag) => args.some((arg) => arg.toLowerCase() === flag.toLowerCase())
const valueAfter = (flag) => {
  const at = args.findIndex((arg) => arg.toLowerCase() === flag.toLowerCase())
  return at >= 0 ? args[at + 1] : undefined
}

if (has('/a')) {
  console.log('abort-shutdown')
  process.exit(Number(process.env.FAKE_SHUTDOWN_ABORT_CODE ?? 0))
}

const seconds = valueAfter('/t') ?? '0'
if (has('/s')) {
  console.log(`scheduled-shutdown:${seconds}`)
  process.exit(Number(process.env.FAKE_SHUTDOWN_CODE ?? 0))
}
if (has('/r')) {
  console.log(`scheduled-reboot:${seconds}`)
  process.exit(Number(process.env.FAKE_SHUTDOWN_CODE ?? 0))
}

console.log(`unknown:${args.join(' ')}`)
process.exit(Number(process.env.FAKE_SHUTDOWN_CODE ?? 1))
