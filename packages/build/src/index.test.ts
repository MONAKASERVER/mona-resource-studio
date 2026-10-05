import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodePackArchive, encodePackArchive, materializePack, sha256 } from "./index.js";

describe("build archive", () => {
  it("round-trips normalized pack files", async () => {
    const bytes = encodePackArchive(new Map([["pack.mcmeta", Buffer.from("{}")], ["assets/mona/a.json", Buffer.from("{\"a\":1}")]]));
    const files = decodePackArchive(bytes); expect([...files.keys()]).toEqual(["assets/mona/a.json", "pack.mcmeta"]);
    const root = await mkdtemp(join(tmpdir(), "mona-build-")); await materializePack(files, root);
    await expect(readFile(join(root, "assets", "mona", "a.json"), "utf8")).resolves.toBe('{"a":1}');
  });

  it("rejects unsafe archive paths and hashes bytes consistently", () => {
    expect(() => encodePackArchive(new Map([["../secret", Buffer.from("x")]]))).toThrow();
    expect(sha256(Buffer.from("mona"))).toBe("132106a20b11b49bb6c2d6a39e302b5ea3d4acc34cfca1ad41e102d2ab898c0f");
  });
});
