/**
 * What a person actually has to do to make each remote provider work.
 *
 * The failure this exists to prevent is a form with an empty "API token" box
 * and no indication of which of a provider's dozen token types is the right
 * one. Each entry names the exact permission, links the page that issues it,
 * and, where the prerequisite is on the Executor host rather than in a
 * dashboard, offers a prompt the user can hand to an agent instead.
 */

import type { CloudBrowserProvider } from "./cloud-providers";

export type SetupStep = {
  readonly text: string;
  /** Opened in a new tab when present. Always https. */
  readonly url?: string;
};

export type ProviderSetup = {
  /** Label for the secret field, or null when the provider takes no secret. */
  readonly credentialLabel: string | null;
  /** The exact permission or scope the credential must carry. */
  readonly permission?: string;
  readonly steps: readonly SetupStep[];
  /**
   * A prompt the user can paste into a coding agent when the setup is easier to
   * delegate than to click through, a prerequisite on the Executor host, or a
   * provider console the agent can already reach over MCP.
   *
   * Never rendered: it is written for an agent to read, and showing twenty
   * lines the user is meant to scroll past buries the fields underneath it.
   * A copy button is the whole interface.
   */
  readonly agentPrompt?: string;
  /** One line naming what the prompt does, shown beside the copy button. */
  readonly agentPromptLabel?: string;
};

const VERCEL_OIDC_PROMPT = `I run a self-hosted Executor instance and want to use its Vercel Sandbox
browser provider with the host's ambient Vercel identity rather than a stored
API token. That means the Executor server process needs a valid
VERCEL_OIDC_TOKEN in its environment.

Please:
1. Check whether this project is already linked to a Vercel project
   (\`vercel link\` / the presence of .vercel/project.json). Link it if not.
2. Pull the development environment so a VERCEL_OIDC_TOKEN is issued
   (\`vercel env pull\`), and confirm the token is present and unexpired.
3. Work out where the Executor server process reads its environment from in
   this deployment, and wire VERCEL_OIDC_TOKEN into it there, not just into my
   interactive shell, since the server is what needs it.
4. Tell me how the token is refreshed and what happens when it expires, because
   these tokens are short-lived and a stale one will look like a broken browser
   provider rather than an auth problem.

If this turns out to be awkward in my deployment, say so: Executor can also use
a plain Vercel API token entered in its UI, which needs nothing on the host.

Do not print the token value.`;

const CLOUDFLARE_MCP_PROMPT = `I want to give my self-hosted Executor a Cloudflare Browser Rendering target,
and I would rather you set up the Cloudflare side than click through it myself.

Please:
1. Use the Cloudflare MCP server if you have it connected; otherwise use the
   Cloudflare dashboard or API directly, and tell me which you used.
2. Find my Cloudflare account ID and confirm Browser Rendering is enabled on
   that account, it is not on by default on every plan, and a token cannot
   grant a capability the account lacks.
3. Create an API token scoped to that account with the "Browser Rendering,
   Edit" permission, and nothing broader. If a suitable token already exists,
   tell me rather than minting a duplicate.
4. Give me the account ID in plain text, and the token by whatever route we
   normally pass secrets, I will paste it into Executor's browser target form.
5. Warn me if the account has a Browser Rendering usage limit or a per-minute
   concurrency cap that a browsing agent would hit.

Do not paste the token into a file, a commit, or a chat log.`;

export const PROVIDER_SETUP: Record<CloudBrowserProvider, ProviderSetup> = {
  "vercel-sandbox": {
    credentialLabel: "API token",
    steps: [
      {
        text: "Create a Vercel API token and paste it below. Team and project are read from the token.",
        url: "https://vercel.com/account/settings/tokens",
      },
      {
        text: "Push a browser image to that project's Container Registry, named remote-agent-browser:latest.",
        url: "https://vercel.com/docs/sandbox/concepts/images",
      },
      {
        text: "Running Executor on Vercel? Tick ambient identity instead and skip the token.",
      },
    ],
    agentPrompt: VERCEL_OIDC_PROMPT,
    agentPromptLabel: "Setup prompt for ambient identity off Vercel",
  },
  "cloudflare-browser-run": {
    credentialLabel: "API token",
    permission: "Browser Rendering, Edit",
    steps: [
      {
        text: "Create an API token with the Browser Rendering permission.",
        url: "https://dash.cloudflare.com/profile/api-tokens",
      },
      {
        text: "Paste it below. The account is read from the token.",
      },
      {
        text: "Test afterwards: a valid token can still lack Browser Rendering.",
      },
    ],
    agentPrompt: CLOUDFLARE_MCP_PROMPT,
    agentPromptLabel: "Setup prompt for an agent with Cloudflare access",
  },
  "browser-use": {
    credentialLabel: "API key",
    steps: [
      {
        text: "Create an API key in your Browser Use cloud account.",
        url: "https://cloud.browser-use.com",
      },
      { text: "Paste it below. The key is checked with a read-only call that starts no session." },
    ],
  },
  "generic-cdp": {
    credentialLabel: "Header value",
    steps: [
      {
        text: "Get the CDP WebSocket URL from your provider, Browserbase, Browserless, Kernel, or your own Chrome.",
      },
      {
        text: "If the endpoint needs authentication, give the header name and value it expects.",
      },
      {
        text: "Some hosted endpoints accept WebSocket upgrades but answer no HTTP probe, so a failed test here does not always mean a broken endpoint.",
      },
      {
        text: "This endpoint is reached from the Executor host, not your browser, and private addresses are permitted so a local Chrome can be used. On a shared instance, that means anyone who can add a target can reach the host's own network.",
      },
    ],
  },
};
