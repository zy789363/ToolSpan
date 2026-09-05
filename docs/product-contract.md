# ToolSpan MCP 产品契约

本文面向实现、集成或审查 ToolSpan MCP 服务的开发者、部署者和安全审查者，定义当前产品版本 `0.7.1` 的可观察行为、工具边界与持久化约束。以下内容是产品契约，不构成超出本文范围的能力承诺。

## 版本与兼容性基线

- 当前产品版本是 `0.7.1`，与根目录 `package.json` 及发布包保持一致。
- 当前 MCP 兼容性基线是固定的 `exact 27` 个工具；`0.7.1` 延续该工具集合，不因产品版本升级而自动增加工具。
- 历史说明：本文早期的 `0.2` 仅表示最初定义这组 27 个工具时的协议基线，不是当前产品版本。除非另有版本化迁移说明，集成方应以本文的 `0.7.1` 行为和固定 27-tool 列表为准。

## 范围

`0.7.1` 延续历史 `0.2` 协议基线：在原文章明确提到的 18 个工具基础上增加 9 个本地文件系统工具，固定公布 27 个工具。在其他“40+”工具的公开契约可用之前，文章未给出定义的其他工具不在当前范围内。

服务面向 Windows，使用 `/mcp` 提供 MCP Streamable HTTP，默认绑定到 `127.0.0.1`，并使用 SQLite 持久化状态。工作区是一个已经存在的目录，也可以是一个已经存在的 Git 工作树（Git worktree）。本服务不创建或删除 Git 工作树（Git worktree）。

## 通用规则

- 每个文件系统操作和运行器操作都必须提供通过工作区注册表解析的 `workspaceId`。
- 相对路径在对应工作区内解释；拒绝工具参数中的绝对路径。
- 所有输入都必须经过校验。可预期的工具或输入失败以 MCP 工具错误返回，而不是作为协议错误返回。
- 读取操作返回简洁的结构化数据和文本摘要。
- 写入、运行、取消、导入、预览和发布操作必须声明准确的 MCP 安全注解。
- 密钥、访问令牌、授权码和完整文件内容不得写入应用日志。

## 工具

### 工作区与文件

| 工具 | 输入 | 可观察结果 |
| --- | --- | --- |
| `open_workspace` | `path` | 打开允许范围内已存在的目录，并返回稳定的 `workspaceId`、规范路径和时间戳。 |
| `list_workspaces` | 可选 `status` | 在不扫描文件系统的情况下列出活动或历史工作区。 |
| `resume_workspace` | `workspaceId` | 将持久化工作区重新标记为活动状态，并返回当前元数据。 |
| `read` | `workspaceId`、`path`，可选 `offset`、`limit` | 按行读取 UTF-8 文本。默认每页 200 行，最多 1000 行。 |
| `write` | `workspaceId`、`path`、`content` | 创建或原子替换 UTF-8 文件；父目录必须已经存在。 |
| `edit` | `workspaceId`、`path`、`oldText`、`newText` | 只替换唯一一次匹配；匹配零次或多次时失败且不写入。 |
| `search_files` | `workspaceId`、`pattern`、`mode`，可选 `glob`、`maxResults` | 使用 ripgrep 执行内容正则搜索或文件名 Glob 搜索；最多返回 200 项。 |
| `list_directory` | `workspaceId`，可选 `path`、`depth`、`maxEntries` | 按稳定顺序列出最多 1000 个目录项；深度为 1～5，不跟随符号链接或 Junction。 |
| `stat_path` | `workspaceId`、`path`，可选 `includeSha256` | 返回目录项类型、大小和时间；最多为 25 MiB 的普通文件计算 SHA-256。 |
| `make_directory` | `workspaceId`、`path`，可选 `recursive` | 创建目录，默认递归创建父目录；目标已经是目录时幂等成功。 |
| `move_path` | `workspaceId`、`source`、`destination` | 移动文件、目录或链接；拒绝覆盖、工作区根目录和移动到自身子目录。 |
| `copy_path` | `workspaceId`、`source`、`destination` | 复制最多 10000 项、256 MiB 的文件或目录；不跟随链接且拒绝覆盖。 |
| `delete_path` | `workspaceId`、`path`，可选 `recursive`、`permanent` | 默认移入工作区外的可恢复存储；非空目录需要 `recursive=true`，永久删除需要 `permanent=true`。 |
| `restore_path` | `workspaceId`、`recoveryId`，可选 `destination` | 恢复到原路径或指定路径；恢复目标必须不存在且父目录必须存在。 |
| `read_many` | `workspaceId`、`files` | 按输入顺序读取最多 20 个 UTF-8 文件页，合计内容最多 1 MiB。 |
| `apply_patch` | `workspaceId`、`operations`，可选 `dryRun` | 预检并执行最多 50 个结构化文本文件创建、编辑或删除操作；失败时回滚已完成操作。 |

### 后台作业

| 工具 | 输入 | 可观察结果 |
| --- | --- | --- |
| `start_job` | `workspaceId`、`runner`、`args` | 异步启动允许的进程，并立即返回 `jobId`。 |
| `poll_job` | `jobId`，可选 `cursor` | 返回作业状态、增量 stdout/stderr 和下一个游标。 |
| `cancel_job` | `jobId` | 终止进程树并返回终态。 |
| `list_jobs` | 可选 `workspaceId`、`status` | 列出持久化的作业摘要。 |

运行器（Runner）包括 `shell`、`svn`、`pytest`、`blender`、`npm`、`pnpm`、`yarn`、`cargo` 和 `dotnet`。每个运行器都定义可执行文件、参数策略、并发上限、超时和输出上限。服务不会通过命令行解释器启动这些进程。`shell` 只是只读可执行文件和子命令白名单的兼容名称，不是任意命令解释器。`svn` 只允许 `status`、`diff`、`info` 和 `log`，强制非交互模式，并拒绝写入子命令、凭据参数、外部 diff、仓库 URL 和工作区上跳路径。

### 作业并发实现基线

作业在命令解析、日志创建和子进程启动期间即占用对应 Runner 的并发配额；启动中的作业不能绕过全局或工作区级限制。当前 `svn` 最多同时运行 4 个作业、单工作区最多 2 个，`blender` 和包管理器 Runner 均为全局及单工作区各 1 个。并发拒绝必须发生在启动前，并返回工具错误。

### 安全实现基线

- `search_files` 将用户模式作为显式正则操作数传给 ripgrep，模式不能改变命令选项解析。
- `blender` 按选项名（包括 `--option=value` 形式）拒绝脚本、自动执行和外部插件相关参数。
- MCP 工具执行失败只返回稳定的通用错误，不回显本机路径、命令参数或内部异常文本。
- 以上安全边界、`svn` 只读参数策略和作业并发限制属于当前 `0.7.1` 契约；实现或文档变更必须同步更新门禁测试。

### 制品

| 工具 | 输入 | 可观察结果 |
| --- | --- | --- |
| `start_capture` | `workspaceId`、`profile`，可选 `jobId` | 将 `workspace_snapshot`、`git_diff` 或 `job_output` 采集到隔离的制品存储中。 |
| `inspect_artifact` | `artifactId` | 返回元数据和有大小限制的文本预览。 |
| `list_artifacts` | 可选 `workspaceId` | 列出制品元数据。 |
| `preview_artifact` | `artifactId`，可选 `ttlSeconds` | 创建有效期为 60～3600 秒的签名公开 URL。 |
| `publish_artifact` | `artifactId` | 明确创建持久有效的公开链接。 |
| `import_asset` | `workspaceId`、`path`、`base64`、`mediaType` | 向工作区内已存在的目录导入最多 25 MiB 的内容；不支持服务端 URL 下载。 |

### 管理

| 工具 | 输入 | 可观察结果 |
| --- | --- | --- |
| `devspace_info` | 无 | 返回服务版本、运行时间、内存、数据库健康状态、运行器可用性和对象计数。 |

由于原文章对名称的描述不一致，当前不公布 `server_info`。只有真实客户端证明兼容性确实需要该名称时才增加它。

## OAuth 权限范围

- `workspace:read`：工作区元数据、文件读取与搜索、作业和制品检查、诊断。
- `workspace:write`：文件和目录创建、编辑、复制、移动、删除、恢复、结构化补丁与资产导入。
- `jobs:run`：启动和取消作业。
- `artifacts:publish`：创建预览链接和持久公开链接。

授权服务器支持带 PKCE S256 的授权码流程和动态客户端注册。受保护资源元数据与授权服务器元数据公布规范的公开资源 URI。`resource` 值会贯穿授权与令牌交换流程，并在每次 MCP 请求中校验。

## 持久化

SQLite 存储工作区、作业、作业日志元数据、制品、OAuth 客户端、授权码、访问令牌和刷新令牌。服务从不存储原始持有者令牌（Bearer Token），只持久化其 SHA-256 哈希。进程重启时，所有非终态作业都会变为 `interrupted`。

可恢复删除内容存放在工作区之外的 `stateDirectory/trash/<workspaceId>/<recoveryId>`，并以 JSON 清单记录原始相对路径、类型、删除时间、项数和字节数。恢复成功后删除对应记录；当前 `0.7.1` 不自动清理未恢复记录。
