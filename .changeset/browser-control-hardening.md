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

The console now shows the access scope the extension is actually enforcing — mode,
control session, Advanced, allowed hosts, expiry — and the extension re-advertises that
scope when it changes instead of only at connect time. Browser tool failures carry stable
codes, so a refusal is distinguishable from a missing tab. Every browser target has a
**Copy prompt** button that puts a ready-to-paste agent briefing on the clipboard —
the tool address plus the target's actual limits — rather than only the bare address.
