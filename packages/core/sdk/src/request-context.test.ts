import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { toolCallerRef } from "./request-context";

describe("tool caller request context", () => {
  it("defaults to no attribution", async () => {
    await expect(Effect.runPromise(Effect.service(toolCallerRef))).resolves.toBeNull();
  });

  it("scopes attribution to one execution", async () => {
    const caller = { name: "codex", version: "1.2.3" };
    const scoped = Effect.service(toolCallerRef).pipe(
      Effect.provideService(toolCallerRef, caller),
    );

    await expect(Effect.runPromise(scoped)).resolves.toEqual(caller);
    await expect(Effect.runPromise(Effect.service(toolCallerRef))).resolves.toBeNull();
  });
});
