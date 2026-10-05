import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { assertPathsWritable } from "./locking.js";

describe("file lock enforcement", () => {
  it("allows writes when no other user owns an active lock", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] }); await expect(assertPathsWritable({ query } as unknown as Pick<PoolClient, "query">, "project", ["pack.mcmeta"], "user-a")).resolves.toBeUndefined();
  });
  it("returns a locked response with owner context", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ path: "assets/mona/a.png", display_name: "Nekomaru", username: "nekomaru" }] });
    await expect(assertPathsWritable({ query } as unknown as Pick<PoolClient, "query">, "project", ["assets/mona/a.png"], "user-a")).rejects.toMatchObject({ statusCode: 423, code: "FILE_LOCKED", details: { username: "nekomaru" } });
  });
});
