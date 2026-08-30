# 安全政策

ToolSpan 提供带 Scope 的远程文件、作业和制品能力。疑似 authentication bypass、path escape、command execution、token disclosure、artifact disclosure 或 Host/Origin bypass 时，请按安全问题处理。

## 支持的版本

| 版本 | 状态 |
| --- | --- |
| Unreleased 0.5.x development line | 接收安全修复 |
| Earlier imported development snapshots | 不支持 |

在 Owner publication gates 完成之前，不会发布稳定版本。

## 私下报告漏洞

不要创建公开 issue，也不要在报告中包含密码、Token、配置内容、私人路径或真实用户数据。

请使用仓库 Owner 配置的私有 vulnerability-reporting channel。公共仓库位置和安全联系渠道当前属于 **OWNER GATE**，本文不会故意编造。如果看不到私有渠道，请在本地保留最小复现，并等待 Owner 发布渠道。

一份有用的私有报告应包含受影响版本、安全边界、使用 synthetic data 的最小复现、预期结果、实际结果和安全缓解措施。绝不要在不属于你或未获得明确评估许可的系统或账号上测试。

## 披露与响应

在发布 Maintainer 和私有联系渠道之前，不承诺响应时间。协调披露细节将通过私有渠道协商。Release notes 必须说明受影响的边界，但不得暴露凭证或可直接用于利用的私人数据。
