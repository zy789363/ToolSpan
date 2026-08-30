# Windows 与 Cloudflare 部署手册

本文面向在 Windows 上验证、安装和维护 ToolSpan 服务，并由所有者管理 Cloudflare 公网入口的人员。命令应从仓库根目录执行；涉及凭据、外部账号或公网资源的步骤仍由所有者手动完成。

## 责任边界

本仓库的自动化可以校验配置、构建并测试服务、安装当前用户的计划任务、验证 Cloudflare 入口规则（Ingress），以及安装或更新 `cloudflared` Windows 服务。

以下涉及身份、密钥或外部权限的操作必须由所有者完成：

1. 拥有或控制公网主机名。
2. 登录 Cloudflare 并授权 `cloudflared`。
3. 创建隧道（Tunnel）和 DNS 路由。
4. 将生成的隧道（Tunnel）凭据复制到服务账号可读的位置。
5. 选择所有者密码。
6. 在 ChatGPT/Codex 中添加并授权 MCP 连接器。

## 1. 在本机验证 ToolSpan

从 `toolspan.config.example.json` 创建已被 Git 忽略的 `.toolspan-dev\toolspan.config.json`，初始化密码哈希，然后运行：

```powershell
.\scripts\preflight.ps1 -ConfigPath .\.toolspan-dev\toolspan.config.json
npm.cmd start -- --config .\.toolspan-dev\toolspan.config.json
```

在另一个终端中验证：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/healthz
```

安装计划任务前，先停止前台运行的服务。

## 2. 安装 ToolSpan 登录任务

该任务以当前用户和有限权限运行，并且只在该用户登录后启动。它不会存储 Windows 账号密码。

```powershell
.\scripts\install-scheduled-task.ps1 `
    -ConfigPath .\.toolspan-dev\toolspan.config.json `
    -TaskName ToolSpan-MCP `
    -Start
```

只有明确要替换现有 `ToolSpan-MCP` 任务时才使用 `-Force`。移除任务：

```powershell
.\scripts\uninstall-scheduled-task.ps1 -TaskName ToolSpan-MCP
```

检查运行状态：

```powershell
Get-ScheduledTask -TaskName ToolSpan-MCP | Get-ScheduledTaskInfo
npm.cmd run doctor -- --config .\.toolspan-dev\toolspan.config.json
```

任务包装脚本会把有限的服务输出追加到已配置状态目录中的服务日志，并保留一个轮转后的 `.1` 文件。

## 3. 创建本地管理的 Cloudflare Tunnel

安装当前版本的 `cloudflared`，然后完成需要浏览器授权的所有者操作：

```powershell
cloudflared.exe tunnel login
cloudflared.exe tunnel create toolspan-mcp
cloudflared.exe tunnel route dns toolspan-mcp mcp.example.com
```

将 [Cloudflare 配置示例](../deploy/cloudflared/config.example.yml) 复制到私有位置，并替换：

- Tunnel UUID；
- `credentials-file` 路径；
- 将 `mcp.example.com` 替换为 `publicBaseUrl` 使用的同一主机名。

如果要作为 Windows 系统服务运行，请把生成的隧道（Tunnel）凭据 JSON 复制到 `LocalSystem` 可读的位置，例如：

```text
C:\Windows\System32\config\systemprofile\.cloudflared\<tunnel-uuid>.json
```

不要提交凭据 JSON、`cert.pem`、所有者 bcrypt 文件、SQLite 状态文件或生成的预览密钥。

安装前先验证入口规则：

```powershell
.\scripts\cloudflare-validate.ps1 -ConfigPath C:\private\cloudflared\config.yml
```

## 4. 将 Cloudflare 安装为 Windows 服务

打开管理员 PowerShell 终端并运行：

```powershell
.\scripts\install-cloudflared-service.ps1 `
    -ConfigPath C:\private\cloudflared\config.yml
```

脚本会先验证入口规则，然后调用官方的 `cloudflared service install`，将服务命令固定到选定配置，设置自动启动并重启服务。除非提供 `-Force`，否则脚本拒绝修改已经存在的服务。

检查服务：

```powershell
Get-Service cloudflared
Get-Content C:\Cloudflared\cloudflared.log -Tail 100
```

Cloudflare 建议将隧道（Tunnel）作为服务运行，并在[官方指南](https://developers.cloudflare.com/tunnel/advanced/local-management/as-a-service/windows/)中说明了 Windows 命令和配置文件布局。

## 5. 外部验证

从不绕过 Cloudflare 的网络路径执行：

```powershell
Invoke-RestMethod https://mcp.example.com/healthz
Invoke-RestMethod https://mcp.example.com/.well-known/oauth-protected-resource
Invoke-RestMethod https://mcp.example.com/.well-known/oauth-authorization-server
```

受保护资源文档必须将资源标识为 `https://mcp.example.com/mcp`；授权服务器文档必须公布 DCR、授权码、刷新令牌和 PKCE S256 支持。

然后在 OpenAI 客户端中将 `https://mcp.example.com/mcp` 添加为远程 MCP URL，并在所有者密码同意页面完成授权。OpenAI 当前要求见[鉴权文档](https://developers.openai.com/plugins/build/auth)。

## 故障恢复

- ToolSpan 无法启动：运行 `npm.cmd run doctor -- --config ...`，检查计划任务历史，并读取配置状态目录中的轮转服务日志。
- 运行器不可用：`devspace_info` 和 `doctor` 会分别报告每个可执行文件的状态。
- 隧道（Tunnel）中断：验证入口规则、检查 `cloudflared` 日志，然后重启服务。
- 作业运行期间服务重启：持久化的非终态作业会变为 `interrupted`；请明确启动一个替代作业。
- 预览 URL 已过期：重新请求预览。已发布 URL 不会过期。
