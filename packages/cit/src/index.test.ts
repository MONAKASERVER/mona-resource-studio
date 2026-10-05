import { describe, expect, it } from "vitest";
import { buildNameTransform, detectConflicts, generateGiveCommand, suggestedVariantId, type CitRule, validateReferences, VariantsCitProvider } from "./index.js";

const rule = (displayName: string, variantId: string): CitRule => ({ id: variantId, displayName, itemIds: ["minecraft:diamond_sword"], variantId, match: "exact" });

describe("Variants-CIT foundation", () => {
  it("keeps Japanese names as mapping keys", () => expect(buildNameTransform([rule("闇精霊の涙", "dark_tear")], "monaka")).toEqual({ function: "remap", map: { "闇精霊の涙": "monaka:dark_tear" } }));
  it("does not invent unsafe IDs from Japanese labels", () => expect(suggestedVariantId("闇精霊の涙")).toBe(""));
  it("reports duplicate IDs", () => expect(new VariantsCitProvider().validate({ provider: "variants-cit-v5", namespace: "monaka", rules: [rule("一", "same"), rule("二", "same")], unknownFiles: new Map() }).some((problem) => problem.code === "CIT_DUPLICATE_ID")).toBe(true));

  it("round trips Japanese name mappings and unknown fields", async () => {
    const path = "assets/monaka/variants-cit/modules/names.json";
    const source = new Map([[path, new TextEncoder().encode(JSON.stringify({
      type: "component_data", items: "minecraft:ghast_tear", futureField: { keep: true },
      parameters: { componentType: "custom_name", expect: "rich_text", futureParameter: 7, transform: { function: "remap", map: { "闇精霊の涙": "monaka:dark_tear" } } },
    }))]]);
    const provider = new VariantsCitProvider(); const document = await provider.parse(source);
    expect(document.rules[0]).toMatchObject({ displayName: "闇精霊の涙", variantId: "dark_tear", itemIds: ["minecraft:ghast_tear"] });
    const generated = await provider.generate(document); const output = JSON.parse(new TextDecoder().decode(generated.get(path)!));
    expect(output.futureField).toEqual({ keep: true });
    expect(output.parameters.futureParameter).toBe(7);
    expect(output.parameters.transform.map["闇精霊の涙"]).toBe("monaka:dark_tear");
  });

  it("keeps unsupported JSON byte-for-byte", async () => {
    const path = "assets/monaka/variants-cit/modules/future.json"; const bytes = new TextEncoder().encode('{"type":"future_type","x":1}');
    const provider = new VariantsCitProvider(); const document = await provider.parse(new Map([[path, bytes]])); const generated = await provider.generate(document);
    expect(generated.get(path)).toEqual(bytes);
  });

  it("parses and generates predicate conditions", async () => {
    const path = "assets/monaka/variants-cit/modules/predicate.json"; const provider = new VariantsCitProvider();
    const document = { provider: provider.id, namespace: "monaka", unknownFiles: new Map<string, Uint8Array>(), rules: [{ ...rule("魔剣", "magic_blade"), sourcePath: path, conditions: [{ kind: "name" as const, operator: "equals" as const, value: "魔剣" }, { kind: "damage" as const, operator: "smaller_or_equals" as const, value: "100" }] }] };
    const generated = await provider.generate(document); const config = JSON.parse(new TextDecoder().decode(generated.get(path)!));
    expect(config.type).toBe("predicates"); expect(config.parameters.predicates[0].precondition.damage).toEqual({ smaller_or_equals: 100 });
    const restored = await provider.parse(generated); expect(restored.rules[0]?.conditions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "damage", value: "100" })]));
  });

  it("detects exact conflicts, partial overlaps and missing references", () => {
    const one = { ...rule("Dark", "dark"), match: "contains" as const, texture: "monaka:item/dark" }; const two = { ...rule("Dark Sword", "dark_sword"), id: "two" };
    const document = { provider: "variants-cit-v5", namespace: "monaka", rules: [one, two], unknownFiles: new Map<string, Uint8Array>() };
    expect(detectConflicts(document).some((problem) => problem.code === "CIT_PARTIAL_CONFLICT")).toBe(true);
    expect(validateReferences(document, new Set()).some((problem) => problem.code === "CIT_MISSING_REFERENCE")).toBe(true);
    expect(detectConflicts({ ...document, rules: [one, { ...one, id: "duplicate" }] })[0]?.code).toBe("CIT_CONFLICT");
  });

  it("generates a modern give command with Japanese JSON text", () => {
    expect(generateGiveCommand({ ...rule("闇精霊の涙", "dark_tear"), itemIds: ["minecraft:ghast_tear"], conditions: [{ kind: "name", operator: "equals", value: "闇精霊の涙" }, { kind: "custom_model_data", operator: "equals", value: "10234" }] })).toContain("minecraft:custom_model_data=10234");
  });
});
