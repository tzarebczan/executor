import { describe, expect, it } from "@effect/vitest";

import { browserAuthMethods, parseBrowserIntegrationConfig } from "./integration-config";

describe("browser integration config", () => {
  it("accepts the legacy local extension config", () => {
    expect(parseBrowserIntegrationConfig({ transport: "reverse", kind: "extension" })).toEqual({
      provider: "local-extension",
      transport: "reverse",
      kind: "extension",
    });
  });

  it("keeps provider credentials out of parsed config", () => {
    expect(
      parseBrowserIntegrationConfig({
        provider: "cloudflare-browser-run",
        accountId: "account-1",
        apiToken: "must-not-survive",
      }),
    ).toEqual({ provider: "cloudflare-browser-run", accountId: "account-1" });
  });

  it("declares the credential placement for each authenticated provider", () => {
    const cloudflare = parseBrowserIntegrationConfig({
      provider: "cloudflare-browser-run",
      accountId: "account-1",
    })!;
    const generic = parseBrowserIntegrationConfig({
      provider: "generic-cdp",
      cdpUrl: "wss://browser.example/devtools",
      auth: { kind: "header", headerName: "X-Api-Key" },
    })!;

    expect(browserAuthMethods(cloudflare)[0]).toMatchObject({
      kind: "apikey",
      template: "api-token",
    });
    expect(browserAuthMethods(generic)[0]).toMatchObject({
      kind: "header",
      template: "header",
    });
  });

  it("rejects malformed remote provider config", () => {
    expect(parseBrowserIntegrationConfig({ provider: "cloudflare-browser-run" })).toBeNull();
    expect(parseBrowserIntegrationConfig({ provider: "generic-cdp" })).toBeNull();
  });
});
