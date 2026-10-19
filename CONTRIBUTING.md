# 参与贡献

欢迎 PR —— 这个插件的目标是「一个文件干完全部活」，所以改动越集中越好。

## 先跑起来

```powershell
git clone https://github.com/pingmike2/dsh-telegram-control.git
cd dsh-telegram-control
node test/tg-control.test.mjs   # 或 npm test
```

测试**不需要真的 Bot token，也不会真关机**：它自己起一个假 Bot API，并用 `test/fixtures/fake-shutdown.mjs` 顶替 `shutdown`。

## 硬约束（会直接拒掉 PR 的）

1. **零第三方依赖**。只能用 `node:` 内建模块。profile 的 `node_modules` 解析不到 `@deepseek-ai/*`，一旦引入外部包，插件在真实环境里根本加载不起来。
2. **不写 `Config` schema**。配置是 `%DSH_HOME%\telegram-control.json`，热加载，改完不重启。
3. **不声明 `inject`**。所有服务在调用点 `ctx.get()` 软解析，缺服务要给出可读错误，不能把整行插件搞失活。
4. **中文文本不要过 PowerShell 管道**。`Get-Content` / `Set-Content` 往返会把 UTF-8 当 GBK 解码，直接把文件写成 `锟斤拷`。用编辑器或 `write` 类工具。
5. **测试必须绿**。当前 117 项断言，新增行为请顺手加断言；`powerExec` 相关测试绝不能碰真电源命令。

## 加一条文案

`locale/zh.json` 和 `locale/en.json` **两份都要加**，key 保持扁平（如 `power.deniedHint`），占位符写成 `{seconds}` 这种形式，缺 key 会回退到 `zh`。

## 提 PR

- 一个 PR 一件事，标题写清动词（`feat:` / `fix:` / `docs:` / `test:`）。
- 描述里说明：为什么改、怎么验证（贴测试输出最好）。
- 改了行为就同步 README（中英两份），改了版本号记得同步 `package.json` 与 `index.js` 的 `version`。

## 报 bug

带上这些信息基本能一次定位：

- `%DSH_HOME%\telegram-control-status.json` 的内容（token 已打码）
- 相关命令或消息原文
- DSH 版本、操作系统
- 状态文件里 `stats.errors` / `stats.lastError`
