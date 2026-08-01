# Browser bridge (path B reverse)

Completes the loop between **Executor Browser** (Chrome extension) and self-hosted Executor:

```text
Agent  →  tools.browser.user.desktop.*  →  callTool(store)
                                 │
Extension ← long-poll jobs ←─────┘
    │
    └── POST result
```

## HTTP (extension)

All routes require the same auth as `/api/*` (API key as `Authorization: Bearer` or `x-api-key`).

| Method   | Path                                                | Role                 |
| -------- | --------------------------------------------------- | -------------------- |
| `POST`   | `/api/browser-bridge/session`                       | Open reverse session |
| `GET`    | `/api/browser-bridge/session/:id/jobs?waitMs=25000` | Long-poll jobs       |
| `POST`   | `/api/browser-bridge/session/:id/result`            | `{ jobId, result }`  |
| `DELETE` | `/api/browser-bridge/session/:id`                   | Close                |
| `GET`    | `/api/browser-bridge/sessions`                      | List mine            |

There is **no** `POST /api/browser-bridge/call` (or `/browser-bridge/call`). Agents use MCP/plugin tools only.

## Agent tools (MCP / execute)

Integration **`browser`**, connection **`desktop`**:

| Tool | Approval | Notes |
|------|----------|--------|
| `status` | no | Live reverse sessions |
| `ping` | no | Liveness via extension |
| `tabs_list` | no | Executor-group tabs only |
| `snapshot` | no | A11y-ish DOM |
| `screenshot` | **yes** | May show sensitive page content |
| `navigate` | **yes** | http(s) only |
| `click` | **yes** | selector / nodeIndex / x+y |
| `type` | **yes** | |
| `tabs_open` | **yes** | http(s) only |
| `call` | **yes** | Generic; **args re-validated** against the target tool (no schema bypass) |

Requires a live extension reverse session for the **same user** as the API key.

Health is **`healthy`** only while the extension has polled within ~90s; otherwise **`degraded`** (stale or missing session).

## Deploy

Enabled on `apps/host-selfhost` via `executor.config.ts`. Rebuild and restart the lab container / process after merging.

In-memory sessions: single process / sticky replica only. Result payloads capped (~6 MiB JSON).
