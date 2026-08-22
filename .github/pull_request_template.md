## What changed

Describe the problem and the smallest implemented solution. Include applicable Requirement IDs.

## Verification

List the exact commands actually run and their results. Do not write “expected to pass.”

## Security boundaries

- [ ] Exact 27 Tool Contract is unchanged, or an approved requirement and fixture explain the change.
- [ ] No arbitrary Shell, MCP Client, Gateway, Agent Runtime, or public admin route was added.
- [ ] Allowed roots, path/link checks, Host/Origin checks, OAuth scopes, runner allowlists, and `shell: false` were not weakened.
- [ ] No secret, real config, private path, user data, external-account identifier, log, or receipt is included.

## Scope and release

- [ ] The diff is limited to the requested change; unrelated user edits were preserved.
- [ ] External, native, legal, and Owner gates are reported separately from deterministic source checks.
- [ ] This pull request does not create a tag or release.
