import { describe, expect, it } from "vitest";
import { getVersionAdapter, hasPngSignature, isBlockedPackFile, normalizePackPath, readPngDimensions } from "./index.js";

describe("resource pack path policy", () => {
  it("normalizes safe paths", () => expect(normalizePackPath("assets\\monaka\\textures/item/a.png")).toBe("assets/monaka/textures/item/a.png"));
  it.each(["../x", "assets/../../x", "/etc/passwd", "C:/x", "assets//x", ".", "assets/CON/file.json", "assets/name. ", "assets/a:b"])("rejects %s", (value) => expect(() => normalizePackPath(value)).toThrow());
  it("blocks executable payloads", () => expect(isBlockedPackFile("assets/a/evil.PS1")).toBe(true));
  it("checks PNG magic", () => expect(hasPngSignature(new Uint8Array([137,80,78,71,13,10,26,10]))).toBe(true));
  it("reads PNG dimensions", () => { const bytes = new Uint8Array(24); bytes.set([137,80,78,71,13,10,26,10]); new DataView(bytes.buffer).setUint32(16, 32); new DataView(bytes.buffer).setUint32(20, 32); expect(readPngDimensions(bytes)).toEqual({ width: 32, height: 32 }); });
});

describe("version adapter", () => {
  it("uses modern metadata for 1.21.11", () => expect(getVersionAdapter("1.21.11").createPackMeta("MONA")).toMatchObject({ pack: { min_format: [75, 0] } }));
  it("creates version-specific item definition paths", () => {
    expect(getVersionAdapter("1.21.11").itemDefinitionPath("monaka", "item/dark_tear")).toBe("assets/monaka/items/dark_tear.json");
    expect(getVersionAdapter("1.21.11").createItemDefinition("monaka:item/dark_tear")).toEqual({ model: { type: "minecraft:model", model: "monaka:item/dark_tear" } });
    expect(getVersionAdapter("1.21.4").itemDefinitionPath("monaka", "item/dark_tear")).toBe("assets/monaka/models/item/dark_tear.json");
  });
});
