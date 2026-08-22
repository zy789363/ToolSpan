# Security policy

ToolSpan exposes scoped remote file, job, and artifact capabilities. Please treat a suspected authentication bypass, path escape, command execution, token disclosure, artifact disclosure, or Host/Origin bypass as security-sensitive.

## Supported versions

| Version | Status |
| --- | --- |
| Unreleased 0.5.x development line | Receives security fixes |
| Earlier imported development snapshots | Not supported |

There is no published stable release until the Owner publication gates are complete.

## Report a vulnerability privately

Do not open a public issue and do not include passwords, tokens, configuration contents, private paths, or real user data in a report.

Use the private vulnerability-reporting channel configured by the repository owner. The public repository location and security contact are currently an **OWNER GATE** and are intentionally not invented in this document. If no private channel is visible, retain the minimal reproduction locally and wait for the owner to publish one.

A useful private report contains the affected version, security boundary, minimal reproduction using synthetic data, expected result, actual result, and any safe mitigation. Never test against systems or accounts you do not own or have explicit permission to assess.

## Disclosure and response

No response-time promise is made before a maintainer and private contact are published. Coordinated disclosure details will be agreed through the private channel. Release notes must describe the boundary affected without exposing credentials or exploit-ready private data.
