import { access, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { importPack, ProjectStorage, scanPack } from "./storage.js";

describe("ProjectStorage", () => {
  it("never resolves outside a project", () => {
    const storage = new ProjectStorage(join(tmpdir(), "mona-storage-test"));
    expect(storage.resolveProjectFile("abc", "assets/monaka/a.json")).toContain(join("abc", "working", "assets"));
    expect(() => storage.resolveProjectFile("abc", "../../secret")).toThrow();
  });

  it("imports a safe pack without flattening assets", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "mona-import-test-"));
    const storage = new ProjectStorage(dataRoot);
    const zip = zipSync({
      "My Pack/pack.mcmeta": new TextEncoder().encode(JSON.stringify({ pack: { pack_format: 75, description: "test" } })),
      "My Pack/assets/monaka/models/item/test.json": new TextEncoder().encode(JSON.stringify({ parent: "item/generated" })),
    });
    const imported = await importPack(storage, "00000000-0000-0000-0000-000000000001", Buffer.from(zip));
    expect(imported.report.fileCount).toBe(2);
    await expect(access(join(storage.projectRoot("00000000-0000-0000-0000-000000000001"), "assets", "monaka", "models", "item", "test.json"))).resolves.toBeUndefined();
  });

  it("rejects Zip Slip before writing outside staging", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "mona-slip-test-"));
    const storage = new ProjectStorage(dataRoot);
    const zip = zipSync({ "../outside.txt": new TextEncoder().encode("no"), "pack.mcmeta": new TextEncoder().encode("{}") });
    await expect(importPack(storage, "00000000-0000-0000-0000-000000000002", Buffer.from(zip))).rejects.toMatchObject({ code: "ZIP_SLIP" });
  });

  it("keeps immutable versions while replacing a working file", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "mona-version-test-")); const storage = new ProjectStorage(dataRoot); const projectId = "00000000-0000-0000-0000-000000000003"; const fileId = "00000000-0000-0000-0000-000000000004";
    const target = storage.resolveProjectFile(projectId, "assets/monaka/test.txt"); await mkdir(join(storage.projectRoot(projectId), "assets", "monaka"), { recursive: true }); await writeFile(target, "old");
    const saved = await storage.snapshotAndReplace(projectId, fileId, "assets/monaka/test.txt", 1, Buffer.from("new"));
    await expect(readFile(target, "utf8")).resolves.toBe("new");
    await expect(readFile(storage.versionPath(projectId, fileId, 1), "utf8")).resolves.toBe("old");
    await expect(readFile(storage.versionPath(projectId, fileId, 2), "utf8")).resolves.toBe("new");
    await storage.restoreWorkingFile(projectId, "assets/monaka/test.txt", saved.oldBytes); await expect(readFile(target, "utf8")).resolves.toBe("old");
  });

  it("creates and removes generated CIT files inside the project root", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "mona-cit-storage-test-")); const storage = new ProjectStorage(dataRoot); const projectId = "00000000-0000-0000-0000-000000000005"; const path = "assets/monaka/variants-cit/modules/test.json";
    await storage.createWorkingFile(projectId, path, Buffer.from('{"type":"component_data"}'));
    await expect(readFile(storage.resolveProjectFile(projectId, path), "utf8")).resolves.toContain("component_data");
    const removed = await storage.removeWorkingFile(projectId, path); expect(removed.toString("utf8")).toContain("component_data");
    await expect(access(storage.resolveProjectFile(projectId, path))).rejects.toBeDefined();
  });

  it("atomically swaps and can roll back a working tree", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "mona-rollback-storage-test-")); const storage = new ProjectStorage(dataRoot); const projectId = "00000000-0000-0000-0000-000000000006";
    await storage.createWorkingFile(projectId, "pack.mcmeta", Buffer.from("old"));
    const swap = await storage.replaceWorkingTree(projectId, new Map([["pack.mcmeta", Buffer.from("new")], ["assets/mona/new.json", Buffer.from("{}")]]));
    await expect(readFile(storage.resolveProjectFile(projectId, "pack.mcmeta"), "utf8")).resolves.toBe("new");
    await swap.rollback(); await expect(readFile(storage.resolveProjectFile(projectId, "pack.mcmeta"), "utf8")).resolves.toBe("old");
  });
});

describe("pack scanner", () => {
  it("reports namespaces, invalid JSON and fake PNG", async () => {
    const root = await mkdtemp(join(tmpdir(), "mona-pack-test-"));
    await mkdir(join(root, "assets", "monaka", "textures", "item"), { recursive: true });
    await writeFile(join(root, "pack.mcmeta"), JSON.stringify({ pack: { pack_format: 75, description: "test" } }));
    await writeFile(join(root, "assets", "monaka", "bad.json"), "{");
    await writeFile(join(root, "assets", "monaka", "textures", "item", "fake.png"), "not png");
    const { report } = await scanPack(root);
    expect(report.namespaces).toEqual(["monaka"]);
    expect(report.problems.map((problem) => problem.code)).toEqual(expect.arrayContaining(["JSON_PARSE", "PNG_SIGNATURE"]));
  });
});
