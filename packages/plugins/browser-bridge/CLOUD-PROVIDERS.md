# Cloud browser providers

`@executor-js/plugin-browser-bridge/cloud-providers` exposes a typed lifecycle adapter for four provider classes:

| Provider | Transport | Implementation |
| --- | --- | --- |
| Vercel Sandbox | `agent-browser` commands | `remote-agent-browser` |
| Cloudflare Browser Run | CDP WebSocket | Native `/browser-rendering/devtools/browser` HTTP lifecycle |
| Browser Use | CDP WebSocket | Native `/api/v3/browsers` lifecycle |
| Generic CDP | CDP WebSocket | Browserbase, Browserless, Kernel, or another compatible endpoint |

The adapter returns one `CloudBrowserHandle` with a normalized session descriptor and an idempotent lifecycle boundary. Provider secrets stay in the caller's connection configuration and are never included in the public session descriptor.

Vercel is command-oriented because `remote-agent-browser` already supplies the mature `agent-browser` surface in an isolated sandbox. The other providers expose CDP so Executor can connect a Playwright, Puppeteer, or CDP-native driver without translating through another daemon.

Always call `handle.close()` in `finally`. Cloudflare and Browser Use charge while a session remains active.
