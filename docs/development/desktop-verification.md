# 桌面端 v0.4 验证（Desktop v0.4）

本文面向负责桌面端 v0.4（Desktop v0.4）源码 Gate、Windows 原生 Gate 和 CI 验证的开发者与发布审查者。它说明各 Gate 的边界、命令和结果含义，不将环境缺失误报为通过，也不把源码验证扩展为安装验证。

桌面端（Desktop）源码 Gate 与 Windows 原生 Gate 独立。源码完成不依赖域名、Cloudflare、真实 Agent Host、签名或 Windows 安装验证；Windows 原生验证未完成会阻塞最终 Release Ready，但不拖住 Setup 源码阶段。

## 本地命令

在仓库根目录依次运行：

```powershell
npm.cmd run desktop:install
npm.cmd run desktop:protocol:check
npm.cmd run verify:desktop:source
npm.cmd run verify:desktop:windows
```

`desktop:install` 只接受解析后的 `npm-cli.js`，并由当前 Node 以 `shell: false` 执行独立 Desktop 锁文件（lockfile）的 `npm ci`。`verify:desktop:source` 真实执行渲染器（Renderer）单测、类型检查（typecheck）、构建（build）、`en/zh-CN key parity`、axe Gate、协议验证、Rust `fmt/check/clippy/test`、Desktop 安全边界、Core 无头验证（headless verification）与打包发布冒烟验证（packed-release smoke）。Windows 上的 Cargo 命令通过 `vswhere` 找到 `Launch-VsDevShell.ps1`，不会依赖调用者已经配置好 `cl.exe` 的 PATH。

`verify:desktop:windows` 先探测 Windows x64、VC 工具链（VC Toolchain）、Windows PowerShell、cscript/VBScript 与 WebView2，再在 VS 开发者 Shell（VS Developer Shell）中执行真实 Tauri 调试构建（debug build）。缺少能力时返回机器可读的 `BLOCKED_BY_ENVIRONMENT` 和退出码 2；源码或构建回归返回退出码 1。仅生成安装程序包（installer bundle）时结果是 `EXTERNAL_GATE_PENDING`，不会宣称 `WINDOWS_NATIVE_VALIDATED`。只有真实安装、托盘（Tray）与自有进程冒烟验证（owned-process smoke）都留下日期化证据后，D-WIN-01 才能标为 PASS。

所有验证输出只报告能力名称、固定错误分类和数量，不输出密钥值（Secret value）。确定性验证子进程还会移除名称看似 credential/token/password/key 的环境变量；Cloudflare 凭据不属于桌面端 v0.4（Desktop v0.4）输入。

## CI

PR 的持续集成（CI）保留 Core 的 Node 22.17/24 与 Windows 矩阵，并增加一个最小 Desktop Ubuntu/Windows Node 24 矩阵。两端都运行完整源码 Gate；Windows runner 在能力存在时尝试原生 Tauri 构建（build），环境缺失只记录 notice，真实构建失败仍使 CI 失败。安装、Tray、进程和签名验证保持 manual/nightly/tag Gate。
