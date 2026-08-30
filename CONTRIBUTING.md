# 为 ToolSpan 贡献

感谢你帮助 ToolSpan 变得更安全、更易于运行。外部贡献和再分发仍受 [LICENSE](LICENSE) 中的许可证 **OWNER GATE** 约束；本文不假定仓库 URL 和 Maintainer 身份。

## 开发环境

使用 Node.js 22.17 或更新版本，然后运行：

```powershell
npm.cmd ci
npm.cmd run verify:core
npm.cmd run smoke:core-release
```

编辑时运行聚焦测试，然后运行相关阶段的验证。不要将真实配置、Secret、账号 ID、私人路径、日志或测试 receipt 放入 commit。

## 范围与设计约束

- 除非获批准的需求明确变更，否则保持精确的 27 Tool Contract。
- 不要添加任意 Shell、MCP Client、Gateway、Agent Runtime、chat 功能或公网管理路由。
- 保持 allowed-root containment、link/junction checks、OAuth scopes、Host/Origin checks、runner allowlists 和 `shell: false`。
- 保持改动小且与 issue 相关。不要重新格式化或重构无关代码。
- 为 bug 添加 regression test，为 feature 添加确定性验证。
- 不要把 external freshness、real-account tests 和 release approvals 设为普通 PR hard gates。

## Pull request

请求评审前：

1. 说明问题和选择的最小解决方案。
2. 如果存在适用的 Requirement ID，请附上链接。
3. 记录实际运行的命令及其真实结果。
4. 说明安全边界变更和迁移影响。
5. 确认未包含 Secret、私人配置、生成状态或外部账号标识符。

使用 [pull request 模板](.github/pull_request_template.md)。安全报告应遵循 [SECURITY.md](SECURITY.md)，不要走公开 issue 流程。
