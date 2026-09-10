import { beforeEach, describe, expect, it } from "@effect/vitest";
import {
  _resetStoreForTests,
  callTool,
  createSession,
  findSessionForConnection,
  listSessionsForUser,
  postResult,
  takeJobs,
  updateSessionCapabilities,
} from "./store";

beforeEach(() => {
  _resetStoreForTests();
});

describe("browser-bridge store", () => {
  it("replaces a reconnect of the same instance, not a second browser", () => {
    const chrome = createSession({
      userId: "u1",
      client: { instanceId: "chrome-1", browser: "Chrome" },
    });
    const brave = createSession({
      userId: "u1",
      client: { instanceId: "brave-1", browser: "Brave" },
    });
    expect(listSessionsForUser("u1")).toHaveLength(2);
    expect(chrome.connectionName).toBe("desktop");
    expect(brave.connectionName).toBe("brave");

    const chromeAgain = createSession({
      userId: "u1",
      client: { instanceId: "chrome-1", browser: "Chrome" },
    });
    const live = listSessionsForUser("u1");
    expect(live).toHaveLength(2);
    expect(live.map((s) => s.connectionName).sort()).toEqual(["brave", "desktop"]);
    expect(findSessionForConnection("u1", "desktop")?.id).toBe(chromeAgain.id);
    expect(findSessionForConnection("u1", "brave")?.id).toBe(brave.id);
  });

  it("still replaces an older extension that sends no instance id", () => {
    const a = createSession({ userId: "u1" });
    const b = createSession({ userId: "u1" });
    expect(listSessionsForUser("u1")).toHaveLength(1);
    expect(listSessionsForUser("u1")[0]!.id).toBe(b.id);
    expect(a.id).not.toBe(b.id);
    expect(b.connectionName).toBe("desktop");
  });

  it("routes a tool call to the named connection", async () => {
    createSession({
      userId: "u1",
      client: { instanceId: "chrome-1", browser: "Chrome" },
    });
    const brave = createSession({
      userId: "u1",
      client: { instanceId: "brave-1", browser: "Brave" },
    });

    const callP = callTool({ userId: "u1", connection: "brave", tool: "ping", args: {} });
    const jobs = await takeJobs(brave.id, "u1", 2000);
    expect(jobs).toHaveLength(1);
    postResult(brave.id, "u1", jobs[0]!.id, { ok: true, browser: "Brave" });
    await expect(callP).resolves.toEqual({ ok: true, browser: "Brave" });
  });

  it("refuses an unaddressed call when two browsers are connected", async () => {
    createSession({
      userId: "u1",
      client: { instanceId: "chrome-1", browser: "Chrome" },
    });
    createSession({
      userId: "u1",
      client: { instanceId: "brave-1", browser: "Brave" },
    });
    await expect(callTool({ userId: "u1", tool: "ping" })).rejects.toThrow(
      /Multiple local browsers/,
    );
  });

  it("does not treat an agent's own call as evidence the extension is alive", async () => {
    const s = createSession({ userId: "u1" });
    const stale = Date.now() - 5 * 60_000;
    s.lastSeenAt = stale;

    // Enqueue work and let it time out; nothing here came from the extension.
    const call = callTool({ userId: "u1", tool: "ping", args: {}, timeoutMs: 10 });
    await call.then(
      () => undefined,
      () => undefined,
    );
    expect(listSessionsForUser("u1")[0]!.lastSeenAt).toBe(stale);

    // The extension polling IS evidence, and does refresh it.
    await takeJobs(s.id, "u1", 1);
    expect(listSessionsForUser("u1")[0]!.lastSeenAt).toBeGreaterThan(stale);
  });

  it("re-advertises access without reopening the session", () => {
    const s = createSession({ userId: "u1", capabilities: { access: { mode: "limited" } } });
    expect(updateSessionCapabilities(s.id, "u1", { access: { mode: "full" } })).toBe(true);
    expect(listSessionsForUser("u1")[0]!.capabilities).toEqual({ access: { mode: "full" } });
    // Same session, the long-poll is not disturbed.
    expect(listSessionsForUser("u1")[0]!.id).toBe(s.id);
  });

  it("will not let one user rewrite another user's advertised scope", () => {
    const s = createSession({ userId: "u1", capabilities: { access: { mode: "limited" } } });
    expect(updateSessionCapabilities(s.id, "u2", { access: { mode: "full" } })).toBe(false);
    expect(listSessionsForUser("u1")[0]!.capabilities).toEqual({ access: { mode: "limited" } });
  });

  it("round-trips a tool call via long-poll + result", async () => {
    const s = createSession({ userId: "u1" });

    const callP = callTool({ userId: "u1", tool: "ping", args: {} });
    const jobs = await takeJobs(s.id, "u1", 2000);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.tool).toBe("ping");

    postResult(s.id, "u1", jobs[0]!.id, { ok: true, mode: "extension-reverse" });
    const result = await callP;
    expect(result).toEqual({ ok: true, mode: "extension-reverse" });
  });

  it("delivers privacy-safe caller attribution with a job", async () => {
    const s = createSession({ userId: "u1" });
    const callP = callTool({
      userId: "u1",
      tool: "snapshot",
      caller: { name: "codex", version: "1.2.3" },
    });
    const jobs = await takeJobs(s.id, "u1", 0);

    expect(jobs[0]?.caller).toEqual({ name: "codex", version: "1.2.3" });
    postResult(s.id, "u1", jobs[0]!.id, { ok: true });
    await expect(callP).resolves.toEqual({ ok: true });
  });

  it("rejects call without session", async () => {
    await expect(callTool({ userId: "nobody", tool: "ping" })).rejects.toThrow(/No live/);
  });

  it("rejects postResult for another user", async () => {
    const s = createSession({ userId: "u1" });
    const callP = callTool({ userId: "u1", tool: "ping", args: {} });
    const jobs = await takeJobs(s.id, "u1", 2000);
    expect(postResult(s.id, "u2", jobs[0]!.id, { ok: true })).toBe(false);
    expect(postResult(s.id, "u1", jobs[0]!.id, { ok: true })).toBe(true);
    await expect(callP).resolves.toEqual({ ok: true });
  });

  it("rejects oversized results", async () => {
    const s = createSession({ userId: "u1" });
    const callP = callTool({ userId: "u1", tool: "screenshot", args: {} });
    const jobs = await takeJobs(s.id, "u1", 2000);
    const huge = "x".repeat(7 * 1024 * 1024);
    expect(postResult(s.id, "u1", jobs[0]!.id, { dataUrl: huge })).toBe(true);
    await expect(callP).rejects.toThrow(/too large/);
  });
});
