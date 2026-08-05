/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor, executor/no-promise-catch, executor/no-promise-reject -- boundary: implements remote-agent-browser's CommandRunner, a promise-and-throw interface, over the Vercel Sandbox SDK; the timeout race and rejection shape are dictated by that contract */

/**
 * Vercel Sandbox browsers authenticated with an API token.
 *
 * `remote-agent-browser` provisions its own sandbox, and the only credential it
 * can use is the ambient one — `VERCEL_OIDC_TOKEN` in the server process, or a
 * local `vercel login`. On a self-hosted Executor that is the single hardest
 * prerequisite in the whole browser feature: the token is short-lived, it has
 * to reach the *server's* environment rather than a shell, and when it is
 * missing the provider simply reads as unavailable.
 *
 * `@vercel/sandbox` itself has always accepted an explicit `token`, so the
 * limitation is only that the library above it does not forward one. It does
 * export `createBrowserClient`, which takes any `CommandRunner` — so provisioning
 * the sandbox here and handing the runner over gets token auth without forking
 * anything. The runner mirrors the library's own sandbox adapter; if that
 * behaviour drifts, this is the file to reconcile.
 *
 * A stored Vercel API token is also a credential Executor may already hold for
 * something else, which is what makes this the cheap path for most people.
 */

import { Sandbox } from "@vercel/sandbox";
import { createBrowserClient, type AgentBrowser, type CommandRunner } from "remote-agent-browser";

/** Matches remote-agent-browser's own sandbox defaults. */
const BASE_ENV = {
  AGENT_BROWSER_ARGS: "--no-sandbox,--disable-dev-shm-usage,--disable-gpu",
  AGENT_BROWSER_DEFAULT_TIMEOUT: "25000",
} as const;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_IMAGE = "remote-agent-browser:latest";
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

export type TokenVercelBrowserOptions = {
  /** Vercel API token. Required — this path exists to avoid ambient identity. */
  readonly token: string;
  /** Team the token is scoped to. Required by the Sandbox API. */
  readonly teamId: string;
  /** Project that owns the sandbox. Required by the Sandbox API. */
  readonly projectId: string;
  readonly image?: string;
  readonly timeoutMs?: number;
  readonly vcpus?: number;
  readonly args?: readonly string[];
};

type SandboxHandle = Awaited<ReturnType<typeof Sandbox.create>>;

/** Injected in tests so the adapter can be exercised without provisioning. */
export type VercelSandboxFactory = (options: {
  readonly token: string;
  readonly teamId: string;
  readonly projectId: string;
  readonly image: string;
  readonly timeout: number;
  readonly resources: { readonly vcpus: number };
  readonly env: Record<string, string>;
}) => Promise<SandboxHandle>;

/**
 * `CommandRunner` over one sandbox.
 *
 * `readFile` goes through base64 rather than a file API because the sandbox's
 * own transfer is one-directional; that is how the upstream adapter does it too,
 * and screenshots and PDFs depend on it.
 */
class TokenSandboxRunner implements CommandRunner {
  constructor(
    private readonly sandbox: SandboxHandle,
    private readonly env: Record<string, string>,
  ) {}

  async run(
    cmd: string,
    args: string[],
    opts: { timeoutMs?: number; env?: Record<string, string> } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const command = await this.sandbox.runCommand({
      cmd,
      args,
      env: { ...this.env, ...opts.env },
      detached: true,
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`command timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
    });

    try {
      const finished = await Promise.race([command.wait(), timeout]);
      const exitCode = typeof finished === "number" ? finished : finished.exitCode;
      const [stdout, stderr] = await Promise.all([
        command.output("stdout"),
        command.output("stderr"),
      ]);
      return { stdout, stderr, exitCode };
    } catch (error) {
      await command.kill().catch(() => {});
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async readFile(path: string): Promise<Buffer> {
    const { stdout, stderr, exitCode } = await this.run("base64", ["-w0", path], {
      timeoutMs: 30_000,
    });
    if (exitCode !== 0) throw new Error(`failed to read ${path}: ${stderr.trim()}`);
    return Buffer.from(stdout.trim(), "base64");
  }

  async writeFile(path: string, bytes: Buffer): Promise<void> {
    await this.sandbox.writeFiles([{ path, content: bytes }]);
  }

  async close(): Promise<void> {
    await this.sandbox.stop().catch(() => {});
  }
}

/**
 * Start a browser in a Vercel Sandbox using an explicit API token.
 *
 * @param deps.createSandbox Overridden in tests. Nothing else should pass it —
 *   a real call here provisions a billable sandbox.
 */
export async function createTokenVercelBrowser(
  options: TokenVercelBrowserOptions,
  deps: { readonly createSandbox?: VercelSandboxFactory } = {},
): Promise<AgentBrowser> {
  if (!options.token) throw new Error("A Vercel API token is required for this browser target");
  if (!options.teamId) throw new Error("A Vercel Team ID is required for this browser target");
  if (!options.projectId)
    throw new Error("A Vercel Project ID is required for this browser target");
  const env: Record<string, string> = { ...BASE_ENV };
  const create =
    deps.createSandbox ||
    ((input) =>
      Sandbox.create({
        token: input.token,
        teamId: input.teamId,
        projectId: input.projectId,
        image: input.image,
        resources: input.resources,
        timeout: input.timeout,
        ports: [],
        env: input.env,
        persistent: false,
      } as Parameters<typeof Sandbox.create>[0]));

  const sandbox = await create({
    token: options.token,
    teamId: options.teamId,
    projectId: options.projectId,
    image: options.image || process.env.REMOTE_AGENT_BROWSER_IMAGE || DEFAULT_IMAGE,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    resources: { vcpus: options.vcpus ?? 2 },
    env,
  });

  return createBrowserClient(new TokenSandboxRunner(sandbox, env), {
    args: options.args ? [...options.args] : undefined,
  });
}
