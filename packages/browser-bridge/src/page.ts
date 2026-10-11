import type { PublicSession } from "./bridge.ts";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function cdpLabel(capabilities: unknown): string {
  const access = asAccess(capabilities);
  if (access?.cdpMode === "always") return "CDP always on";
  if (access?.cdpMode === "session") return access.advanced ? "CDP allowed" : "CDP for a while";
  if (access?.advanced) return "CDP on";
  return "CDP off";
}

function asAccess(capabilities: unknown): { cdpMode?: string; advanced?: boolean } | undefined {
  if (!capabilities || typeof capabilities !== "object") return undefined;
  const access = (capabilities as { access?: unknown }).access;
  if (!access || typeof access !== "object") return undefined;
  return access as { cdpMode?: string; advanced?: boolean };
}

function age(lastSeenAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - lastSeenAt) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

/** One screen: who is connected, whether developer tools are on, where to point the extension. */
export function renderBrowsersPage(input: {
  readonly signedIn: boolean;
  readonly sessions: readonly PublicSession[];
  readonly origin: string;
}): string {
  const now = Date.now();
  const rows = input.sessions.length === 0
    ? `<p class="empty">No browser connected.</p>`
    : input.sessions.map((session) => {
        const name = escapeHtml(session.label || session.browser || session.connection);
        const fresh = now - session.lastSeenAt < 45_000;
        return `<li class="${fresh ? "live" : "stale"}">
          <span class="lamp" aria-hidden="true"></span>
          <span class="name">${name}</span>
          <span class="meta">${escapeHtml(cdpLabel(session.capabilities))} · ${escapeHtml(age(session.lastSeenAt, now))}</span>
          <code>${escapeHtml(session.address)}</code>
        </li>`;
      }).join("");
  const status = !input.signedIn
    ? "Sign in to see this host's browsers."
    : input.sessions.length === 0
      ? "Waiting for a browser."
      : `${input.sessions.length} connected`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="refresh" content="5" />
  <title>Browsers</title>
  <style>
    :root { color-scheme: dark; --ink: #f4f1ea; --muted: #9a958c; --live: #3ddc84; --wait: #e2a23a; --line: #2a2a2a; }
    body { margin: 0; background: #0a0a0a; color: var(--ink); font: 16px/1.4 system-ui, sans-serif; }
    main { max-width: 720px; margin: 0 auto; padding: 32px 20px 48px; }
    h1 { font: 600 15px/1 ui-monospace, monospace; letter-spacing: -0.04em; margin: 0; }
    .status { font-size: 28px; margin: 12px 0 8px; }
    .where { color: var(--muted); margin: 0 0 28px; }
    code, .meta { font-family: ui-monospace, monospace; font-size: 13px; }
    ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    li { display: grid; grid-template-columns: 12px 1fr auto; gap: 8px 12px; align-items: center; border-top: 1px solid var(--line); padding-top: 10px; }
    li code { grid-column: 2 / -1; color: var(--muted); }
    .lamp { width: 8px; height: 8px; border-radius: 50%; background: var(--wait); }
    .live .lamp { background: var(--live); }
    .empty, .note { color: var(--muted); }
  </style>
</head>
<body>
  <main>
    <h1>executor browsers</h1>
    <p class="status">${escapeHtml(status)}</p>
    <p class="where">Extension address <code>${escapeHtml(input.origin)}</code></p>
    ${input.signedIn ? `<ol>${rows}</ol>` : `<p class="empty">Sign in, then reload this page.</p>`}
    <p class="note">Point Executor Browser at this address. It finds a tailnet name on its own. Agents call <code>${escapeHtml(input.origin)}/api/browser-bridge/mcp</code> with the same API key.</p>
  </main>
</body>
</html>`;
}
