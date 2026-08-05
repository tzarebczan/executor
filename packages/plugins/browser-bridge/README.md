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

Every route requires a **presented** credential — an API key as `Authorization: Bearer`
or `x-api-key`. A browser session cookie is rejected even when it identifies the same
user: this is a machine surface, and accepting an ambient cookie would let any page the
user has open inject tool results or rewrite the advertised access scope.

| Method   | Path                                                | Role                    |
| -------- | --------------------------------------------------- | ----------------------- |
| `POST`   | `/api/browser-bridge/session`                       | Open reverse session    |
| `GET`    | `/api/browser-bridge/session/:id/jobs?waitMs=25000` | Long-poll jobs          |
| `POST`   | `/api/browser-bridge/session/:id/result`            | `{ jobId, result }`     |
| `PATCH`  | `/api/browser-bridge/session/:id`                   | Re-advertise `{ capabilities }` |
| `DELETE` | `/api/browser-bridge/session/:id`                   | Close                   |
| `GET`    | `/api/browser-bridge/sessions`                      | List mine               |

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

## Remote browser targets

Each remote provider becomes its own integration with its own tool address, alongside
local Chrome. Adding one validates the credential before writing anything, so a target
built around a rejected token is never created; the **Test** button on a target re-checks
it later without starting a session.

| Provider | Credential | What to give it |
|----------|-----------|-----------------|
| Vercel Sandbox | API token | A Vercel API token, optionally scoped to a team and project |
| Cloudflare Browser Run | API token | Account ID + a token carrying **Browser Rendering - Edit** |
| Browser Use | API key | A key from your Browser Use cloud account |
| Generic CDP | optional header | The CDP WebSocket URL, plus an auth header if the endpoint needs one |

Each provider's setup steps link the page that issues the right credential, and
Vercel and Cloudflare also offer a prompt you can hand to an agent instead — one
for putting `VERCEL_OIDC_TOKEN` on the host, one for driving the Cloudflare
console over MCP. The prompts are copy-only: they are written for an agent to
read, not for you.

### Vercel Sandbox: token or ambient identity

`remote-agent-browser` provisions its sandbox with whatever ambient Vercel
identity the process has — `VERCEL_OIDC_TOKEN`, or a local `vercel login`. That
is automatic when Executor runs on Vercel and awkward everywhere else, since the
token is short-lived and has to reach the *server's* environment rather than a
shell.

A Vercel API token avoids all of that, so it is the default. `@vercel/sandbox`
accepts one directly; the sandbox is provisioned here and handed to
`createBrowserClient`, which is the same client the library would have built.
Tick **ambient identity** on the target instead if Executor runs on Vercel, or if
you would rather keep the credential out of Executor.

A token is checked against `/v2/user` — and against `/v2/teams/:id` when a team
is given — before the target is created. Sandbox entitlement is not readable
from the API, so a passing check reports the credential as good and the
entitlement as unconfirmed rather than claiming both.

Two controls apply to every remote target:

- **Idle timeout** (default 10 minutes, never longer than the provider's own lifetime).
  Remote browsers bill for wall-clock time, so an unused session is closed. The
  replacement session does not keep open tabs or sign-ins, so `session_status` reports
  `idleExpiresAt` and an agent can see it coming.
- **Advanced tools** (`evaluate`, `pdf`, `console`, `network`, dialogs, viewport), on by
  default. The local extension gates these behind Advanced mode and a live control
  session because they run inside the user's signed-in Chrome; a remote browser holds no
  personal session, so they are ordinary capability there. Turning the switch off removes
  them from that target's catalog entirely.

### Generic CDP reaches the network the Executor host can see

A Generic CDP endpoint is dialled **from the Executor host**, and loopback and private
addresses are deliberately allowed so that `ws://127.0.0.1:9222` — a Chrome the operator
started themselves — works. On a single-operator self-hosted instance that is the point
of the provider. On a shared instance it means anyone who can add a browser target can
make the host connect to an address of their choosing and drive whatever answers, so
either restrict who may add targets or do not enable this provider there.

If you already hold a matching credential in Executor, the add form offers to reuse it.
Reuse copies the value at that moment - it does not track later changes to the original -
and the copy is validated before the target is created.

## Connecting the extension

The extension dials **out** to Executor; Executor never connects to the browser. It needs
two things: the Executor base URL and an API key.

**With Tailscale** (typical). Serve Executor on the tailnet and give the extension the
MagicDNS URL, e.g. `https://<host>.<tailnet>.ts.net:<port>`. Nothing has to be exposed to
the public internet, and the extension reaches Executor from any device on the tailnet.
Because the extension dials out, the browser needs no inbound rule of its own.

**Without Tailscale.** Any origin the browser can reach works:

- *Same machine* - `http://localhost:3000` (or your port). The simplest setup; the
  extension's connect screen probes localhost first.
- *LAN or remote host* - put Executor behind HTTPS with a certificate the browser already
  trusts. A self-signed certificate fails the extension's `fetch` with no useful error.
- *Reverse proxy* - pin the public origin in Executor's config, so OAuth callbacks and
  approval links point at the address the browser can actually reach rather than the
  internal bind address.

In every case the API key is what authenticates. A browser session cookie is deliberately
not accepted on the bridge routes.

## Deploy

Enabled on `apps/host-selfhost` via `executor.config.ts`. Rebuild and restart the container / process after merging.

In-memory sessions: single process / sticky replica only. Remote provider sessions are
in-process too, so a restart drops them; the next browser call recreates one. Result payloads capped (~6 MiB JSON).
