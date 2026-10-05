import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { folderFilesToZip } from "./folderZip.js";

describe("folder import", () => {
  it("keeps relative paths", async () => {
    const file = new File(["{}"], "pack.mcmeta");
    Object.defineProperty(file, "webkitRelativePath", { value: "My Pack/pack.mcmeta" });
    const list = { 0: file, length: 1, item: (index: number) => index === 0 ? file : null, [Symbol.iterator]: function* () { yield file; } } as unknown as FileList;
    const zip = await folderFilesToZip(list);
    expect(Object.keys(unzipSync(new Uint8Array(await zip.arrayBuffer())))).toEqual(["My Pack/pack.mcmeta"]);
  });
});

