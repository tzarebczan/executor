# @executor-js/plugin-browser-bridge

## Unreleased

- Multiple Executor Browser extensions can stay connected at once. Each instance
  is its own catalog connection (`tools.browser.user.desktop`,
  `tools.browser.user.brave`, …) so agents can tell them apart. `status` lists
  every live local browser and its address.
- Validate generic `call` args against the target tool schema (blocks `javascript:` etc.).
- Require approval for `screenshot` (sensitive content).
- Health `degraded` when reverse session is stale (>90s since last extension poll).
- Cap result payload size (~6 MiB JSON).
- No HTTP `/browser-bridge/call` (agents use plugin tools only).
