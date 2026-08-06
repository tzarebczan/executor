---
"executor": patch
---

**Browser control: remote targets now report real credential health instead of an unconditional `healthy`, idle remote sessions are closed instead of billing until process exit, and the reverse-bridge routes require a presented API key rather than accepting a browser session cookie**

Adding a remote browser target validates its credential first and refuses to create one
around a rejected token, with the specific remedy (bad token vs missing Browser Rendering
permission vs unreachable provider). A per-target **Test** button re-checks it later
without starting a session. Existing credentials can be reused, but only from the sources
the picker offers, and the copy is validated before the target is created.

Idle remote sessions are reaped on a per-target timeout that is never longer than the
provider's own lifetime, and never while a tool call is in flight; `session_status`
reports `idleExpiresAt` so an agent can see a session lapse coming. Advanced tools
(`evaluate`, `pdf`, `console`, `network`) became a per-target property enforced in both
the catalog and the call, rather than a gate that existed only in the extension.

Vercel Sandbox accepts a plain Vercel API token, so it no longer requires an ambient
`VERCEL_OIDC_TOKEN` in the server's environment and is no longer reported as unavailable on
every self-hosted instance. `@vercel/sandbox` has always taken an explicit token; the
sandbox is now provisioned here and handed to `remote-agent-browser`'s own client, which is
what makes that reachable. Ambient identity stays available as a per-target option, an
existing Vercel credential in the catalog is offered for reuse, and the token is checked
against the Vercel API before the target is created. Each provider's setup guidance links
the page that issues the right credential; Vercel and Cloudflare also offer a copy-only
prompt to hand the whole setup to an agent.

The console now shows the access scope the extension is actually enforcing, mode,
control session, Advanced, allowed hosts, expiry, and the extension re-advertises that
scope when it changes instead of only at connect time. Browser tool failures carry stable
codes, so a refusal is distinguishable from a missing tab. Every browser target has a
**Copy prompt** button that puts a ready-to-paste agent briefing on the clipboard:
the tool address plus the target's actual limits, rather than only the bare address.

A Vercel Sandbox target now needs only a token. Team and project are inferred from it
through the SDK's own `inferScope`, which also provisions a default sandbox project, and
both fields move to Advanced for the cases where a specific team has to be named. Session
tuning moves there with them, leaving the form at one credential.

Cloudflare gets the same treatment: the account ID is read from the token through
`/accounts` when the field is left blank, and only refuses to guess when a token spans
several accounts. The ambient-Vercel option is offered only on hosts that actually carry a
`VERCEL_OIDC_TOKEN`, since the server already knows and asking the user to work it out
meant explaining OIDC to people whose host could never use it.

Each target gains a **Test run** that starts a real session, loads a page, and stops it
again. The credential check answers "is this token live"; for Vercel it stops at "token
accepted, entitlement not confirmed", because entitlement is not readable from the API.
Only starting one can tell you the thing browses, so that is offered separately rather
than folded into a check that is safe to run casually.

A credential that cannot be copied can now often create one that can. An MCP or OAuth
connection to the same provider is listed with **Create token using existing credentials**
rather than hidden: for Cloudflare it looks up the Browser Rendering permission group and
creates an API token scoped to that permission on one account, and nothing else. The
existing credential is never copied and never leaves the server, the minting happens only
on an explicit click, and the offer is not made for providers whose API cannot do it.

An endpoint that fails with a bare string used to reach the page as the caller's generic
fallback, because the shared exit-to-message helper decoded only `{ message }` objects. So
"Enter the Cloudflare account ID" was shown as "Could not add this browser provider", which
named nothing the user could act on. The helper now keeps a string failure, and the reuse
picker no longer offers OAuth-minted or expiring connections: a Cloudflare MCP access token
matched the name filter but is not a Browser Rendering API token and cannot be made into
one. Nor does a target offer its own credential back, which it did because the name filter
matched the target's own name.
