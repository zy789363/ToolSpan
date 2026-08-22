# Contributing to ToolSpan

Thank you for helping make ToolSpan safer and easier to operate. External contribution and redistribution remain subject to the license **OWNER GATE** in [LICENSE](LICENSE); the repository URL and maintainer identity are not assumed here.

## Development setup

Use Node.js 22.17 or newer, then run:

```powershell
npm.cmd ci
npm.cmd run verify:core
npm.cmd run smoke:core-release
```

Run focused tests while editing, then the relevant stage verification. Do not put real configuration, secrets, account IDs, private paths, logs, or test receipts in a commit.

## Scope and design constraints

- Preserve the exact 27 Tool Contract unless an approved requirement explicitly changes it.
- Do not add an arbitrary Shell, MCP Client, Gateway, Agent Runtime, chat feature, or public administration route.
- Preserve allowed-root containment, link/junction checks, OAuth scopes, Host/Origin checks, runner allowlists, and `shell: false`.
- Keep changes small and related to the issue. Do not reformat or refactor unrelated code.
- Add a regression test for a bug and deterministic verification for a feature.
- Keep external freshness, real-account tests, and release approvals out of ordinary PR hard gates.

## Pull requests

Before requesting review:

1. Explain the problem and the smallest chosen solution.
2. Link the applicable Requirement ID when one exists.
3. Record the commands actually run and their real results.
4. Document security-boundary changes and migration impact.
5. Confirm that no secret, private config, generated state, or external-account identifier is included.

Use [the pull request template](.github/pull_request_template.md). Security reports follow [SECURITY.md](SECURITY.md), not the public issue flow.
