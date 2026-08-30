## 变更内容

描述问题与选择的最小解决方案。如适用，附上对应的 Requirement ID。

## 验证

列出实际运行的命令及其真实结果。不要写“预计通过”。

## 安全边界

- [ ] 精确的 27 Tool Contract 保持不变，或由已批准的需求与 fixture 说明变更。
- [ ] 未添加任意 Shell、MCP Client、Gateway、Agent Runtime 或公网管理路由。
- [ ] allowed roots、路径/link 检查、Host/Origin 检查、OAuth scopes、runner allowlists 与 `shell: false` 未被削弱。
- [ ] 不包含 Secret、真实配置、私人路径、用户数据、外部账号标识符、日志或 receipt。

## 范围与发布

- [ ] diff 限定于请求的变更；无关的用户改动已保留。
- [ ] 外部、原生、法律与 Owner 门禁与确定性源码检查分开报告。
- [ ] 本 pull request 不创建 tag 或 release。
