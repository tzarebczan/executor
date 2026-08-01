# @executor-js/plugin-browser-bridge

## Unreleased

- Validate generic `call` args against the target tool schema (blocks `javascript:` etc.).
- Require approval for `screenshot` (sensitive content).
- Health `degraded` when reverse session is stale (>90s since last extension poll).
- Cap result payload size (~6 MiB JSON).
- No HTTP `/browser-bridge/call` (agents use plugin tools only).
