import { describe, expect, it } from "@effect/vitest";

import { CLOUD_BROWSER_PROVIDERS } from "./cloud-providers";
import { PROVIDER_SETUP } from "./provider-setup";

describe("provider setup guidance", () => {
  it("covers every provider the catalog offers", () => {
    for (const provider of CLOUD_BROWSER_PROVIDERS) {
      const setup = PROVIDER_SETUP[provider.id];
      expect(setup, provider.id).toBeDefined();
      expect(setup.steps.length, provider.id).toBeGreaterThan(0);
    }
  });

  it("only links over https, so no step can downgrade the user to plaintext", () => {
    const urls = Object.values(PROVIDER_SETUP).flatMap((setup) =>
      setup.steps.flatMap((step) => (step.url ? [step.url] : [])),
    );
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((url) => !url.startsWith("https://"))).toEqual([]);
  });

  it("gives every provider a credential field to fill in", () => {
    // Vercel used to be the exception, with no field and only a prompt for
    // putting VERCEL_OIDC_TOKEN on the host. It accepts a plain API token now,
    // so there is no provider left whose setup cannot be completed in this form.
    for (const [id, setup] of Object.entries(PROVIDER_SETUP)) {
      expect(setup.credentialLabel, id).not.toBeNull();
    }
  });

  it("labels every agent prompt, since none of them is ever displayed", () => {
    for (const [id, setup] of Object.entries(PROVIDER_SETUP)) {
      if (!setup.agentPrompt) continue;
      expect(setup.agentPromptLabel, id).toBeTruthy();
    }
  });

  it("offers a prompt wherever the setup is easier to delegate than to click", () => {
    // The Vercel host prerequisite cannot be satisfied from any dashboard, and
    // the Cloudflare console is one an agent can already reach over MCP.
    expect(PROVIDER_SETUP["vercel-sandbox"].agentPrompt).toContain("VERCEL_OIDC_TOKEN");
    expect(PROVIDER_SETUP["cloudflare-browser-run"].agentPrompt).toContain("MCP");
    expect(PROVIDER_SETUP["cloudflare-browser-run"].agentPrompt).toContain("Browser Rendering");
  });

  it("names the permission for the provider whose tokens are scoped per feature", () => {
    expect(PROVIDER_SETUP["cloudflare-browser-run"].permission).toContain("Browser Rendering");
  });

  it("never invites an agent to write a token somewhere it will persist", () => {
    // These prompts are handed to agents that can run commands and edit files,
    // so the instruction not to spill the credential is part of the prompt's
    // contract rather than a nicety.
    expect(PROVIDER_SETUP["vercel-sandbox"].agentPrompt).toContain("Do not print the token value");
    expect(PROVIDER_SETUP["cloudflare-browser-run"].agentPrompt).toContain(
      "Do not paste the token",
    );
  });
});
