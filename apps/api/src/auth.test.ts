import argon2 from "argon2";
import { describe, expect, it } from "vitest";
import { hashToken } from "./auth.js";
import { loadConfig } from "./config.js";

describe("authentication primitives", () => {
  it("uses Argon2id password hashes", async () => {
    const encoded = await argon2.hash("a-strong-test-password", { type: argon2.argon2id });
    expect(encoded).not.toContain("a-strong-test-password");
    await expect(argon2.verify(encoded, "a-strong-test-password")).resolves.toBe(true);
  });

  it("stores only deterministic refresh token hashes", () => {
    expect(hashToken("secret-token")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken("secret-token")).toBe(hashToken("secret-token"));
  });

  it("refuses development secrets in production", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/Production refuses/);
  });
});
