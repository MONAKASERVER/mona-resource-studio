import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { decodePackArchive, encodePackArchive, materializePack, ObjectStore, sha256 } from "./index.js";

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

  it("stores production artifacts on a filesystem volume", async () => {
    const root = await mkdtemp(join(tmpdir(), "mona-objects-"));
    const store = new ObjectStore({ endpoint: pathToFileURL(root).href, accessKey: "local", secretKey: "local-secret", bucket: "studio" });
    await store.put("releases/project/build.zip", Buffer.from("artifact"));
    await expect(store.get("releases/project/build.zip")).resolves.toEqual(Buffer.from("artifact"));
    await store.remove("releases/project/build.zip");
    await expect(store.get("releases/project/build.zip")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
