/* oxlint-disable executor/no-try-catch-or-throw, executor/no-error-constructor, executor/no-promise-catch, executor/no-promise-reject -- boundary: implements remote-agent-browser's CommandRunner, a promise-and-throw interface, over the Vercel Sandbox SDK; the timeout race and rejection shape are dictated by that contract */

/**
 * Vercel Sandbox browsers authenticated with an API token.
 *
 * `remote-agent-browser` provisions its own sandbox, and the only credential it
 * can use is the ambient one, `VERCEL_OIDC_TOKEN` in the server process, or a
 * local `vercel login`. On a self-hosted Executor that is the single hardest
 * prerequisite in the whole browser feature: the token is short-lived, it has
 * to reach the *server's* environment rather than a shell, and when it is
 * missing the provider simply reads as unavailable.
 *
 * `@vercel/sandbox` itself has always accepted an explicit `token`, so the
 * limitation is only that the library above it does not forward one. It does
 * export `createBrowserClient`, which takes any `CommandRunner`, so provisioning
 * the sandbox here and handing the runner over gets token auth without forking
 * anything. The runner mirrors the library's own sandbox adapter; if that
 * behaviour drifts, this is the file to reconcile.
 *
 * A stored Vercel API token is also a credential Executor may already hold for
 * something else, which is what makes this the cheap path for most people.
 */

import { Sandbox } from "@vercel/sandbox";
import { inferScope } from "@vercel/sandbox/dist/auth/index.js";
import { createBrowserClient, type AgentBrowser, type CommandRunner } from "remote-agent-browser";

/** Matches remote-agent-browser's own sandbox defaults. */
const BASE_ENV = {
  AGENT_BROWSER_ARGS: "--no-sandbox,--disable-dev-shm-usage,--disable-gpu",
  AGENT_BROWSER_DEFAULT_TIMEOUT: "25000",
} as const;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

export type TokenVercelBrowserOptions = {
  /** Vercel API token. Required: this path exists to avoid ambient identity. */
  readonly token: string;
  /**
   * Team and project that own the sandbox.
   *
   * Both are optional because `inferScope` derives them from the token, which
   * is what makes a pasted token sufficient on its own. Supply them only to
   * override that choice: a token with access to several teams resolves to the
   * default one, and a specific team has to be named to beat it.
   */
  readonly teamId?: string;
  readonly projectId?: string;
  readonly image?: string;
  readonly timeoutMs?: number;
  readonly vcpus?: number;
  readonly args?: readonly string[];
  /**
   * Stable name for the sandbox backing this target.
   *
   * Supplying it turns provisioning into get-or-create: a later session finds
   * the same machine, already carrying the browser, instead of building a new
   * one. Without it every session starts from nothing, which is what made a
   * second run as slow as the first.
   *
   * Never derived from anything secret: sandbox names are visible in the Vercel
   * dashboard and in API responses.
   */
  readonly sandboxName?: string;
};

type SandboxHandle = Awaited<ReturnType<typeof Sandbox.create>>;

/** Injected in tests so the adapter can be exercised without provisioning. */
export type VercelSandboxFactory = (options: {
  readonly token: string;
  readonly teamId: string;
  readonly projectId: string;
  /** Mutually exclusive with `runtime`, exactly as the Sandbox API requires. */
  readonly image?: string;
  readonly runtime?: string;
  readonly timeout: number;
  readonly resources: { readonly vcpus: number };
  readonly env: Record<string, string>;
  /** Set when the sandbox is reusable; absent for a one-shot sandbox. */
  readonly name?: string;
  /** Run once, and only when the sandbox was freshly created. */
  readonly onCreate?: (sandbox: SandboxHandle) => Promise<void>;
}) => Promise<SandboxHandle>;

/**
 * Stock runtime used when no browser image is configured.
 *
 * `image` and `runtime` are mutually exclusive in the Sandbox API: a sandbox
 * boots from one or the other. Omitting the image is what makes the Container
 * Registry unnecessary.
 */
const BOOTSTRAP_RUNTIME = "node24";

/** Install commands are one-off and slow; the browser download dominates. */
const BOOTSTRAP_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * Put `agent-browser` and a Chrome into a stock sandbox.
 *
 * The alternative is the documented path: build a browser image, push it to the
 * project's Vercel Container Registry, and keep it current. That is a real
 * chore, it is invisible from this UI, and getting it wrong surfaces much later
 * as a bare 404 from the sandbox API. Since the CLI publishes to npm and can
 * fetch its own Chrome from Chrome for Testing, the sandbox can assemble itself
 * instead, and a Vercel browser needs nothing but a token.
 *
 * The cost is real and paid on every cold start: an npm install plus a browser
 * download, which is why a configured image still wins when one exists.
 */
async function bootstrapAgentBrowser(runner: TokenSandboxRunner): Promise<void> {
  const install = await runner.run("npm", ["install", "-g", "agent-browser"], {
    timeoutMs: BOOTSTRAP_TIMEOUT_MS,
  });
  if (install.exitCode !== 0) {
    throw new Error(
      `Could not install agent-browser in the sandbox: ${install.stderr.trim() || install.stdout.trim()}`,
    );
  }
  // `--with-deps` is what makes this work on a stock image: Chrome needs shared
  // libraries a plain Node runtime does not ship, and without them the browser
  // downloads successfully and then fails to launch.
  const browser = await runner.run("agent-browser", ["install", "--with-deps"], {
    timeoutMs: BOOTSTRAP_TIMEOUT_MS,
  });
  if (browser.exitCode !== 0) {
    throw new Error(
      `Could not install Chrome in the sandbox: ${browser.stderr.trim() || browser.stdout.trim()}`,
    );
  }
}

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

/** Injected in tests. Mirrors `inferScope` from `@vercel/sandbox`. */
export type VercelScopeResolver = (opts: {
  token: string;
  teamId?: string;
}) => Promise<{ teamId: string; projectId: string }>;

/**
 * Fill in whichever of team and project the user did not supply.
 *
 * `inferScope` picks the token's default team and provisions a default sandbox
 * project when none exists, so a token alone is enough. Asking for both IDs up
 * front made three fields mandatory to reach a browser when the SDK could
 * answer two of them, and a wrong ID fails at start time with a bare 404.
 *
 * Skipped entirely when both are already known, so an explicit choice costs no
 * extra API call and cannot be silently overridden.
 */
async function resolveScope(
  options: TokenVercelBrowserOptions,
  infer: VercelScopeResolver,
): Promise<{ teamId: string; projectId: string }> {
  if (options.teamId && options.projectId) {
    return { teamId: options.teamId, projectId: options.projectId };
  }
  const scope = await infer({
    token: options.token,
    ...(options.teamId ? { teamId: options.teamId } : {}),
  });
  return {
    teamId: options.teamId || scope.teamId,
    projectId: options.projectId || scope.projectId,
  };
}

/**
 * Start a browser in a Vercel Sandbox using an explicit API token.
 *
 * @param deps.createSandbox Overridden in tests. Nothing else should pass it:
 *   a real call here provisions a billable sandbox.
 */
export async function createTokenVercelBrowser(
  options: TokenVercelBrowserOptions,
  deps: {
    readonly createSandbox?: VercelSandboxFactory;
    readonly inferScope?: VercelScopeResolver;
  } = {},
): Promise<AgentBrowser> {
  if (!options.token) throw new Error("A Vercel API token is required for this browser target");
  const scope = await resolveScope(options, deps.inferScope || inferScope);
  const env: Record<string, string> = { ...BASE_ENV };
  const create =
    deps.createSandbox ||
    ((input) => {
      const shared = {
        token: input.token,
        teamId: input.teamId,
        projectId: input.projectId,
        // Exactly one of these is set. Passing `image: undefined` alongside a
        // runtime is still passing the key, and the API rejects the pair.
        ...(input.image ? { image: input.image } : { runtime: input.runtime }),
        resources: input.resources,
        timeout: input.timeout,
        ports: [],
        env: input.env,
      };
      if (!input.name) {
        return Sandbox.create({
          ...shared,
          persistent: false,
        } as Parameters<typeof Sandbox.create>[0]);
      }
      // `getOrCreate` resumes a sandbox of this name when one exists, and
      // `onCreate` runs only when it did not, so the install happens once per
      // machine rather than once per session. `persistent` keeps the filesystem
      // across resumes, which is what the installed browser lives on.
      // `getOrCreate` returns a plain Sandbox while `create` returns one that
      // is also AsyncDisposable. This adapter never uses `using`, so the extra
      // member is irrelevant to every call site here.
      return Sandbox.getOrCreate({
        ...shared,
        name: input.name,
        resume: true,
        persistent: true,
        onCreate: input.onCreate,
      } as Parameters<typeof Sandbox.getOrCreate>[0]) as Promise<SandboxHandle>;
    });

  // An image is used when one is configured, and only then. The default used to
  // be `remote-agent-browser:latest`, which nobody had pushed, so the first
  // session of every new target failed on a registry lookup for an image the
  // user had never heard of.
  const image = options.image?.trim() || process.env.REMOTE_AGENT_BROWSER_IMAGE?.trim() || "";
  const name = options.sandboxName?.trim() || "";
  // Only the unnamed path can bootstrap after the fact. A named sandbox may be
  // a resume, where the browser is already installed and running the installer
  // again would add a minute to every call for nothing.
  const bootstrapOnCreate =
    !image && name
      ? async (fresh: SandboxHandle) => {
          await bootstrapAgentBrowser(new TokenSandboxRunner(fresh, env));
        }
      : undefined;

  const sandbox = await create({
    token: options.token,
    teamId: scope.teamId,
    projectId: scope.projectId,
    ...(image ? { image } : { runtime: BOOTSTRAP_RUNTIME }),
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    resources: { vcpus: options.vcpus ?? 2 },
    env,
    ...(name ? { name } : {}),
    ...(bootstrapOnCreate ? { onCreate: bootstrapOnCreate } : {}),
  });

  const runner = new TokenSandboxRunner(sandbox, env);
  if (!image && !name) {
    try {
      await bootstrapAgentBrowser(runner);
    } catch (error) {
      // A half-built sandbox bills for as long as its timeout allows, and this
      // one can never serve a request.
      await sandbox.stop().catch(() => {});
      throw error;
    }
  }

  return createBrowserClient(runner, {
    args: options.args ? [...options.args] : undefined,
  });
}
