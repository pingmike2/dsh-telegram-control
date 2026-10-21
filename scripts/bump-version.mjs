#!/usr/bin/env node
// 版本号约定（本项目）：
//   · 用户没有明确要求"升版本号 / 发版"时，只在末尾**追加第 4 段**，不动 major/minor/patch：
//       1.4.0 → 1.4.0.1 → 1.4.0.2 → 1.4.0.3 …
//     这样连续迭代不会把 minor 号一路冲上去（1.4.0 直接跳到 1.5.2 那种）。
//   · 用户明确说"升到 1.5 / 打个大版本"时才走 --minor / --major / --patch / --set。
//
// 用法：
//   node scripts/bump-version.mjs                 # 末尾段 +1（没有第 4 段就补 .1）
//   node scripts/bump-version.mjs --set 1.4.0.7   # 指定为某个版本
//   node scripts/bump-version.mjs --patch         # 1.4.0.3 → 1.4.1（需用户明确要求）
//   node scripts/bump-version.mjs --minor         # 1.4.x   → 1.5.0（需用户明确要求）
//   node scripts/bump-version.mjs --major         # 1.x     → 2.0.0（需用户明确要求）
//   node scripts/bump-version.mjs --dry           # 只打印，不落盘

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const dry = args.includes('--dry')
const setIndex = args.indexOf('--set')

function bumpExtend(version) {
  const parts = version.split('.')
  const nums = parts.map((part) => Number.parseInt(part, 10))
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`当前版本号不是纯数字点分格式：${version}`)
  }
  if (nums.length >= 4) nums[nums.length - 1] += 1
  else nums.push(1)
  return nums.join('.')
}

function bumpTraditional(version, level) {
  const nums = version.split('.').slice(0, 3).map((part) => Number.parseInt(part, 10))
  while (nums.length < 3) nums.push(0)
  if (level === 'major') return `${nums[0] + 1}.0.0`
  if (level === 'minor') return `${nums[0]}.${nums[1] + 1}.0`
  return `${nums[0]}.${nums[1]}.${nums[2] + 1}`
}

function nextVersion(current) {
  if (setIndex !== -1) {
    const value = args[setIndex + 1]
    if (!value || !/^\d+(\.\d+){2,3}$/.test(value)) throw new Error(`--set 需要一个 3~4 段版本号，收到：${value}`)
    return value
  }
  if (args.includes('--major')) return bumpTraditional(current, 'major')
  if (args.includes('--minor')) return bumpTraditional(current, 'minor')
  if (args.includes('--patch')) return bumpTraditional(current, 'patch')
  return bumpExtend(current)
}

const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const current = String(pkg.version)
const next = nextVersion(current)

const targets = [
  {
    file: 'package.json',
    read: () => JSON.stringify(pkg, null, 2) + '\n',
    render: (text) => text.replace(`"version": "${current}"`, `"version": "${next}"`),
  },
  {
    file: 'index.js',
    read: () => readFileSync(join(root, 'index.js'), 'utf8'),
    render: (text) => {
      const pattern = new RegExp(`export const version = '${current.replace(/\./g, '\\.')}'`)
      if (!pattern.test(text)) throw new Error(`index.js 里找不到 export const version = '${current}'`)
      return text.replace(pattern, `export const version = '${next}'`)
    },
  },
  {
    file: 'README.md',
    read: () => readFileSync(join(root, 'README.md'), 'utf8'),
    render: (text) => text.replace(`"version": "${current}"`, `"version": "${next}"`),
  },
  {
    file: 'README.en.md',
    read: () => readFileSync(join(root, 'README.en.md'), 'utf8'),
    render: (text) => text.replace(`"version": "${current}"`, `"version": "${next}"`),
  },
]

const pending = []
for (const target of targets) {
  const before = target.read()
  const after = target.render(before)
  if (after === before) {
    console.log(`  · ${target.file} 已是最新（跳过）`)
    continue
  }
  pending.push({ file: target.file, after })
}

console.log(`版本号：${current} → ${next}`)
if (dry) {
  console.log(`（--dry，未落盘；将改动：${pending.map((item) => item.file).join(', ') || '无'}）`)
  process.exit(0)
}

for (const item of pending) {
  // 一律 UTF-8 无 BOM 写回：绝不走 PowerShell 文本管道，避免中文被 GBK 解坏
  writeFileSync(join(root, item.file), item.after, 'utf8')
  const bytes = readFileSync(join(root, item.file))
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error(`${item.file} 被写入了 BOM`)
  const text = bytes.toString('utf8')
  if (text.includes('\uFFFD')) throw new Error(`${item.file} 出现替换字符，编码被破坏`)
  console.log(`  ✔ ${item.file}`)
}

// 收尾自检：四处版本号必须一致
const check = {
  'package.json': JSON.parse(readFileSync(pkgPath, 'utf8')).version,
  'index.js': /export const version = '([^']+)'/.exec(readFileSync(join(root, 'index.js'), 'utf8'))?.[1],
  'README.md': /"version": "([^"]+)"/.exec(readFileSync(join(root, 'README.md'), 'utf8'))?.[1],
  'README.en.md': /"version": "([^"]+)"/.exec(readFileSync(join(root, 'README.en.md'), 'utf8'))?.[1],
}
const mismatch = Object.entries(check).filter(([, value]) => value !== next)
if (mismatch.length > 0) {
  console.error('版本号不一致：', mismatch)
  process.exit(1)
}
console.log(`自检通过：四处均为 ${next}`)
