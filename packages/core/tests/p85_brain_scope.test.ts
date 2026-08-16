/**
 * P8.5：非 trusted 走 core 鉴权。插件测无法模拟非 local 时以此单测为准。
 */
import { describe, expect, test } from "bun:test";
import { authorize, assertBrainScope, ErrorCodes, MemoryError } from "../src/index.ts";

describe("P8.5 assertBrainScope", () => {
  test("trusted local：authorize 的 brain 与目标一致可通过", () => {
    const ctx = authorize({ channel: "cli", brainId: "default", token: null });
    expect(ctx.trustedLocal).toBe(true);
    expect(() => assertBrainScope(ctx, "default")).not.toThrow();
  });

  test("ctx.brainId 与目标不一致 → E_FORBIDDEN（不读不写）", () => {
    const ctx = authorize({ channel: "cli", brainId: "default", token: null });
    try {
      assertBrainScope(ctx, "team-b");
      throw new Error("expected throw");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(MemoryError);
      expect((e as MemoryError).code).toBe(ErrorCodes.FORBIDDEN);
    }
  });

  test("remote 无 token → E_AUTH（非 local 不隐式放行）", () => {
    try {
      authorize({ channel: "remote", brainId: "team-b", token: null });
      throw new Error("expected throw");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(MemoryError);
      expect((e as MemoryError).code).toBe(ErrorCodes.AUTH);
    }
  });
});
