import { describe, expect, it } from "@effect/vitest";

import {
  accessFromCapabilities,
  BROWSER_TOOL_CATALOG,
  connectionTestFromProbe,
  connectionOffersReusableSecret,
  credentialLooksReusable,
  integrationIsBrowserTarget,
  providerCanMint,
  localBridgeVerdict,
  remoteAdvancedAllowed,
  remoteCatalogResult,
  SESSION_STALE_MS,
  validateInnerCall,
} from "./server";
import { browserToolCatalogName } from "./protocol";
import type { BridgeSession } from "./store";

const catalogByName = new Map(BROWSER_TOOL_CATALOG.map((entry) => [String(entry.name), entry]));

describe("browser bridge tool catalog", () => {
  it("publishes an input schema for every tool", () => {
    for (const entry of BROWSER_TOOL_CATALOG) {
      expect(entry.inputSchema, String(entry.name)).toBeDefined();
    }
  });

  it.each(["call", "navigate", "click", "type", "tabs_open", "screenshot", "evaluate"])(
    "requires approval for %s",
    (name) => {
      expect(catalogByName.get(name)?.annotations?.requiresApproval).toBe(true);
    },
  );

  it.each(["status", "snapshot", "tabs_list", "ping"])(
    "does not mark read-only tool %s as mutating",
    (name) => {
      expect(catalogByName.get(name)?.annotations?.requiresApproval).not.toBe(true);
    },
  );
});

describe("validateInnerCall", () => {
  it("accepts navigate with https URL", () => {
    const out = validateInnerCall("navigate", { url: "https://example.com/x" });
    expect(out.tool).toBe("navigate");
    expect(out.args.url).toBe("https://example.com/x");
  });

  it("rejects javascript: navigate URLs", () => {
    expect(() => validateInnerCall("navigate", { url: "javascript:alert(1)" })).toThrow(
      /invalid format|HTTP/,
    );
  });

  it("rejects unexpected args on ping", () => {
    expect(() => validateInnerCall("ping", { evil: true })).toThrow(/Unexpected arg/);
  });

  it("rejects unknown tools", () => {
    expect(() => validateInnerCall("eval", {})).toThrow(/Unknown browser tool/);
  });

  it("requires click target", () => {
    expect(() => validateInnerCall("click", {})).toThrow(/selector|nodeIndex|x and y/);
  });

  it("accepts the expanded interaction surface", () => {
    expect(validateInnerCall("press", { key: "Enter" }).tool).toBe("press");
    expect(validateInnerCall("wait", { selector: "#ready", timeoutMs: 5000 }).tool).toBe("wait");
    expect(validateInnerCall("viewport.set", { width: 1280, height: 720 }).tool).toBe(
      "viewport.set",
    );
  });

  it("rejects unknown arguments on every path", () => {
    expect(() => validateInnerCall("snapshot", { secret: true })).toThrow(/Unexpected argument/);
  });
});

const NOW = 1_700_000_000_000;

const session = (overrides: Partial<BridgeSession> = {}): BridgeSession =>
  ({
    id: "sess_abcdef123456789",
    userId: "user-1",
    kind: "browser",
    transport: "reverse",
    createdAt: NOW - 60_000,
    lastSeenAt: NOW,
    pending: [],
    inflight: new Map(),
    waiters: [],
    ...overrides,
  }) as BridgeSession;

describe("localBridgeVerdict", () => {
  it("does not report an absent extension as healthy", () => {
    const verdict = localBridgeVerdict([], NOW);
    expect(verdict.status).toBe("degraded");
    expect(verdict.detail).toContain("Connect");
  });

  it("degrades a session that stopped polling, and says how long ago", () => {
    const verdict = localBridgeVerdict(
      [session({ lastSeenAt: NOW - SESSION_STALE_MS - 5_000 })],
      NOW,
    );
    expect(verdict.status).toBe("degraded");
    expect(verdict.detail).toMatch(/stopped answering 9[0-9]s ago/);
    expect(verdict.detail).toContain("Reconnect");
  });

  it("reports a freshly polled session as healthy with the extension it identified as", () => {
    const verdict = localBridgeVerdict(
      [
        session({
          lastSeenAt: NOW - 1_000,
          client: { name: "executor-browser", version: "1.4.0" },
          capabilities: { tools: ["ping", "snapshot"] },
        }),
      ],
      NOW,
    );
    expect(verdict.status).toBe("healthy");
    expect(verdict.detail).toContain("executor-browser 1.4.0");
    expect(verdict.detail).toContain("2 tools");
    // The transport name is not user vocabulary.
    expect(verdict.detail.toLowerCase()).not.toContain("reverse");
  });
});

describe("accessFromCapabilities", () => {
  it("reports the scope the extension advertised, including the parts once dropped", () => {
    const access = accessFromCapabilities({
      tools: ["ping"],
      access: {
        mode: "limited",
        sessionActive: true,
        advanced: true,
        allowedHosts: ["example.com", "docs.example.com"],
        expiresAt: 1_700_000_000_000,
      },
    });
    expect(access).toEqual({
      mode: "limited",
      sessionActive: true,
      advanced: true,
      allowedHosts: ["example.com", "docs.example.com"],
      expiresAt: 1_700_000_000_000,
    });
  });

  it("treats an absent or malformed advertisement as unknown rather than permissive", () => {
    expect(accessFromCapabilities(null)).toBeNull();
    expect(accessFromCapabilities({ tools: [] })).toBeNull();
    expect(accessFromCapabilities({ access: { mode: "anything-goes" } })).toBeNull();
  });

  it("does not infer permissions from missing fields", () => {
    const access = accessFromCapabilities({ access: { mode: "full" } });
    expect(access).toEqual({
      mode: "full",
      sessionActive: false,
      advanced: false,
      allowedHosts: [],
    });
  });
});

describe("remote Advanced gating", () => {
  const target = { provider: "generic-cdp" as const, cdpUrl: "wss://x" };
  const advancedNames = ["evaluate", "pdf", "console.list", "network.list"] as const;
  const remoteToolNames = (config: Parameters<typeof remoteCatalogResult>[0]) =>
    remoteCatalogResult(config).tools.map((entry) => String(entry.name));

  it("exposes Advanced tools by default, since a remote browser holds no personal session", () => {
    expect(remoteAdvancedAllowed(target)).toBe(true);
    const published = remoteToolNames({ ...target, allowAdvanced: true });
    for (const name of advancedNames) {
      expect(published, name).toContain(browserToolCatalogName(name as never));
    }
  });

  it("withholds them from the catalog when the target turns them off", () => {
    expect(remoteAdvancedAllowed({ ...target, allowAdvanced: false })).toBe(false);
    const published = remoteToolNames({ ...target, allowAdvanced: false });
    for (const name of advancedNames) {
      expect(published, name).not.toContain(browserToolCatalogName(name as never));
    }
    // The ordinary browsing surface is untouched.
    expect(published).toContain(browserToolCatalogName("snapshot"));
    expect(published).toContain("session_start");
  });
});

describe("credentialLooksReusable", () => {
  it("offers a Cloudflare credential for the Cloudflare browser provider", () => {
    expect(credentialLooksReusable("cloudflare-browser-run", "cloudflare-dns", "Cloudflare")).toBe(
      true,
    );
    expect(credentialLooksReusable("browser-use", "browser-use", "Browser Use")).toBe(true);
  });

  it("does not offer an unrelated credential", () => {
    expect(credentialLooksReusable("cloudflare-browser-run", "github", "GitHub")).toBe(false);
    // A Cloudflare token is no use to Browser Use, and vice versa.
    expect(credentialLooksReusable("browser-use", "cloudflare-dns", "Cloudflare")).toBe(false);
  });

  it("is the gate as well as the offer", () => {
    // `addProvider` re-checks this before resolving another integration's
    // secret. Without that, a request could name any integration and have its
    // token copied into a generic-cdp target whose auth header and endpoint
    // URL the same request supplies, sending the secret wherever it liked.
    expect(credentialLooksReusable("generic-cdp", "cloudflare-dns", "Cloudflare")).toBe(false);
    expect(credentialLooksReusable("cloudflare-browser-run", "stripe", "Stripe")).toBe(false);
  });

  it("offers nothing for the provider whose credential belongs to one endpoint", () => {
    // A CDP header value is specific to the endpoint that issued it, so no
    // other connection in the catalog can be assumed to carry a usable one.
    expect(credentialLooksReusable("generic-cdp", "browserbase", "Browserbase")).toBe(false);
  });

  it("offers a Vercel credential to the Vercel browser", () => {
    // A Vercel API token is one credential for the whole account, so an
    // integration already holding one can back a sandbox browser too. This is
    // still only an offer: the user picks it and the copy is probed first.
    expect(credentialLooksReusable("vercel-sandbox", "vercel", "Vercel")).toBe(true);
    expect(credentialLooksReusable("vercel-sandbox", "stripe", "Stripe")).toBe(false);
  });
});

describe("integrationIsBrowserTarget", () => {
  it("does not offer a browser target its own credential back", () => {
    // The name filter matches "vercel" against the integration's own name, and
    // a Vercel Sandbox target is itself called "Vercel Sandbox". Adding a
    // second target therefore listed the first as a reuse candidate beside the
    // real Vercel integration, with nothing to tell the two apart.
    expect(integrationIsBrowserTarget({ kind: "browser-bridge" })).toBe(true);
    expect(integrationIsBrowserTarget({ kind: "openapi" })).toBe(false);
  });
});

describe("providerCanMint", () => {
  it("offers to create a token only where the provider's API can", () => {
    // Vercel issues API tokens through its dashboard. A button that always
    // fails is worse than no button, so the offer is not made there.
    expect(providerCanMint("cloudflare-browser-run")).toBe(true);
    expect(providerCanMint("vercel-sandbox")).toBe(false);
    expect(providerCanMint("browser-use")).toBe(false);
    expect(providerCanMint("generic-cdp")).toBe(false);
  });
});

describe("connectionOffersReusableSecret", () => {
  it("offers a pasted API token", () => {
    expect(connectionOffersReusableSecret({ oauthClient: null })).toBe(true);
    expect(connectionOffersReusableSecret({})).toBe(true);
  });

  it("does not offer a credential that expires", () => {
    // An expiring credential is a session. A copy of it stops working later
    // with nothing having changed on the target that adopted it, which reads
    // as the browser breaking by itself.
    expect(connectionOffersReusableSecret({ expiresAt: 1_700_000_000_000 })).toBe(false);
  });

  it("does not offer an OAuth access token as if it were an API token", () => {
    // The name filter matches any integration containing "cloudflare", which
    // includes a Cloudflare MCP connection minted by OAuth. Its access token is
    // not a Browser Rendering API token and it expires, so adopting one copied
    // a credential that could never work into a new target and failed the add
    // with a message about a bad token rather than a bad choice.
    expect(connectionOffersReusableSecret({ oauthClient: "cloudflare-mcp" })).toBe(false);
  });
});

describe("connectionTestFromProbe", () => {
  it("keeps an unconfirmed permission distinguishable from a verified one", () => {
    const view = connectionTestFromProbe(
      { ok: true, detail: "Token valid", permissionVerified: false },
      "Cloudflare Browser Run",
      NOW,
    );
    expect(view).toMatchObject({ ok: true, verified: false, checkedAt: NOW });
    expect(view.detail).toContain("Cloudflare Browser Run");
    expect(view.hint).toBeUndefined();
  });

  it("carries the remedy through to the view on every failure", () => {
    const view = connectionTestFromProbe(
      { ok: false, reason: "permission", detail: "Missing scope", hint: "Reissue the token." },
      "Browser Use",
      NOW,
    );
    expect(view).toMatchObject({ ok: false, reason: "permission", verified: false });
    expect(view.hint).toBe("Reissue the token.");
  });
});
