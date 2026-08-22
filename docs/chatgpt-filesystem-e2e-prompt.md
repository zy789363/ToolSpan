# ChatGPT 文件系统工具组验收提示词

在本地副本中替换 `<EXPECTED_REMOTE_INSTANCE>`、`<EXACT_ALLOWED_ROOTS_JSON>` 和 `<SELECTED_ALLOWED_ROOT>` 后，再将以下提示词发送给已连接 ToolSpan MCP 的 ChatGPT。三项都是本地已知的非 Secret 配置；不要在聊天中补填或询问任何 Secret。

```text
你是 ToolSpan MCP 文件系统工具的严格验收 Agent。

本次验收安全不变量：
- REMOTE_INSTANCE_CONFIRMATION=REQUIRED
- EXACT_ALLOWED_ROOTS_CONFIRMATION=REQUIRED
- SYNTHETIC_FIXTURE_ONLY=true
- DELETE_HUMAN_CONFIRMATION=REQUIRED
- FULL_RESULT_ECHO=false
- SECRET_ECHO=false
- IDENTIFIER_ECHO=false

本地预填的非 Secret 期望值：
- expected remote instance：<EXPECTED_REMOTE_INSTANCE>
- exact allowedRoots：<EXACT_ALLOWED_ROOTS_JSON>
- selected allowed root：<SELECTED_ALLOWED_ROOT>

边界：
1. 只允许调用当前连接上的 ToolSpan MCP；不使用浏览器、代码解释器、其他连接器或其他 MCP。
2. 先只读调用 `devspace_info`。确认 service 为 toolspan、`instanceName` 与 expected remote instance 完全一致，并确认工具总数 exact 27；任一不符立即停止。
3. 在任何写入或 `open_workspace` 前必须暂停。请人类在本地 ToolSpan UI 或配置中确认：当前 remote instance 的 `instanceName` 完全一致，且完整 exact allowedRoots 的逐项、顺序和数量完全一致。只接受人类明确确认；不得要求其把路径、配置或凭证回显到聊天。
4. 未得到上述确认，或任何占位符尚未在本地替换时，不得继续。确认后仅用 selected allowed root 调用一次 `open_workspace`，不得列出或读取根目录内容。
5. 生成唯一相对目录名 `toolspan-synthetic-fixture-<时间>-<随机串>`。除 `devspace_info` 和为绑定根而进行的 `open_workspace` 外，所有文件系统工具的 `path`、`source`、`destination` 都必须位于这个 synthetic fixture 内；不得探测、读取或修改 fixture 之外的路径。
6. 不调用 `publish_artifact`，不使用 permanent delete。`workspaceId` 和 `recoveryId` 只能在当前会话内部传给后续工具，不得输出或请人类复述。
7. 在每一次 `delete_path` 或 `apply_patch` 的 `delete_file` 前都必须暂停，只展示经清理的 fixture 内相对目标与操作数量，并取得人类明确确认。未确认不得调用；一次确认不能覆盖下一次删除。
8. 不得输出完整 tool input 或完整 tool result；不得输出任何 Secret、Token、密码或凭证；不得输出 `workspaceId` 或 `recoveryId`。失败时只报告步骤号、工具名、稳定错误码和不含路径或标识符的简短摘要。

只在上述边界内按顺序执行：

阶段 1：创建 synthetic fixture
1. 使用 `make_directory` 创建 `<fixture>/src/nested`、`<fixture>/copies` 和 `<fixture>/moved`。
2. 再次创建 `<fixture>/src/nested`，验证幂等成功且 `created=false`。
3. 使用 `write` 在 fixture 内创建 README、两个普通文本文件和一个 nested 文本文件；内容只能是明显的合成测试文本。

阶段 2：只读取 fixture
4. 使用 `list_directory` 查看 fixture，验证返回路径为正斜杠、包含预期项且未截断。
5. 使用 `stat_path` 检查 fixture 内一个文件和一个目录；文件摘要应为 64 位 SHA-256。
6. 使用 `read_many` 一次读取 fixture 内三个文件，验证内容与输入顺序一致。

阶段 3：复制、移动和补丁
7. 使用 `copy_path` 在 fixture 内复制一个文件和一个目录，再使用 `read` 验证副本。
8. 使用 `move_path` 把副本移动到 fixture 的 moved 子目录，并用 `stat_path` 验证。
9. 对 fixture 内 README 调用 `apply_patch`：先 `dryRun=true`，只包含一个 `create_file` 和一个 `edit_file`；确认 `applied=false` 且文件未变化。
10. 使用相同的无删除 operations 调用 `apply_patch`，`dryRun=false`，再验证新文件和编辑结果。
11. 构造一次 fixture 内的补丁失败，验证没有产生部分修改。该预期错误不计为 FAIL。

阶段 4：可恢复删除
12. 在调用前执行独立的人类确认检查点；确认后，使用 `delete_path` 可恢复地删除 fixture 内的 moved 子目录，不传 permanent。
13. 只在内部保存返回的 `recoveryId`，使用 `restore_path` 恢复，再验证恢复内容。

阶段 5：清理
14. 再次执行独立的人类确认检查点；确认后，使用 `delete_path` 可恢复地删除整个 fixture，不传 permanent。
15. 使用 `stat_path` 验证 fixture 已不存在；该路径不存在是 EXPECTED_ERROR。不要恢复，也不要永久删除最终回收项。

最后仅输出经清理的汇总：
- PASS、EXPECTED_ERROR、FAIL 的数量；
- exact 27 是否成立，以及预期 9 个文件系统工具是否均可用；
- fixture 是否已移除；
- 是否调用过 permanent delete（必须为 false）；
- 是否调用过 `publish_artifact`（必须为 false）。

汇总中不包含原始工具输入、原始工具结果、绝对路径、Secret 或任何 workspace/recovery 标识符。只有 FAIL=0、fixture 已移除、未永久删除且未调用 `publish_artifact`，才给出“文件系统工具组验收通过”。
```
