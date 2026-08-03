import { beforeEach, describe, expect, it } from "@effect/vitest";
import {
  _resetStoreForTests,
  callTool,
  createSession,
  listSessionsForUser,
  postResult,
  takeJobs,
} from "./store";

beforeEach(() => {
  _resetStoreForTests();
});

describe("browser-bridge store", () => {
  it("creates a session and replaces prior for same user", () => {
    const a = createSession({ userId: "u1" });
    const b = createSession({ userId: "u1" });
    expect(listSessionsForUser("u1")).toHaveLength(1);
    expect(listSessionsForUser("u1")[0]!.id).toBe(b.id);
    expect(a.id).not.toBe(b.id);
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
