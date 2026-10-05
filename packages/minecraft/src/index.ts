import type { StudioProblem } from "@mona/shared";

export const IMPORT_LIMITS = Object.freeze({ zipBytes: 100 * 1024 * 1024, expandedBytes: 300 * 1024 * 1024, files: 10_000 });
const BLOCKED_EXTENSIONS = new Set([".exe", ".dll", ".com", ".bat", ".cmd", ".ps1", ".msi", ".scr", ".lnk", ".jar"]);

export function normalizePackPath(input: string): string {
  const value = input.normalize("NFC").replaceAll("\\", "/").replace(/^\.\//, "");
  if (!value || value.includes("\0") || value.startsWith("/") || /^[a-zA-Z]:\//.test(value)) throw new Error("absolute_or_empty_path");
  const parts = value.split("/");
  if (parts.some((part) => part === ".." || part === "")) throw new Error("path_traversal");
  const normalized = parts.filter((part) => part !== ".");
  if (normalized.length === 0) throw new Error("empty_path");
  if (normalized.some((part) => /[\u0001-\u001f<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) throw new Error("windows_unsafe_path");
  return normalized.join("/");
}

export function isBlockedPackFile(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && BLOCKED_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

export function hasPngSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
}

export function readPngDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (!hasPngSignature(bytes) || bytes.length < 24) throw new Error("invalid_png_header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export interface MinecraftVersionAdapter {
  id: string;
  packFormat: number;
  itemComponents: boolean;
  itemDefinitionDirectory: "items" | "models/item";
  createPackMeta(description: string): Record<string, unknown>;
  itemDefinitionPath(namespace: string, modelId: string): string;
  createItemDefinition(modelId: string): Record<string, unknown>;
}

const VERSION_FORMATS: Record<string, number> = { "1.21.4": 46, "1.21.5": 55, "1.21.6": 63, "1.21.7": 64, "1.21.8": 64, "1.21.9": 69, "1.21.10": 69, "1.21.11": 75, "26.1": 84, "26.1.1": 84, "26.1.2": 84 };

export function getVersionAdapter(version: string): MinecraftVersionAdapter {
  const packFormat = VERSION_FORMATS[version] ?? 75;
  return {
    id: version,
    packFormat,
    itemComponents: true,
    itemDefinitionDirectory: packFormat >= 55 ? "items" : "models/item",
    createPackMeta: (description) => packFormat >= 65
      ? { pack: { description, min_format: [packFormat, 0], max_format: [packFormat, 0] } }
      : { pack: { description, pack_format: packFormat } },
    itemDefinitionPath: (namespace, modelId) => packFormat >= 55
      ? `assets/${namespace}/items/${modelId.replace(/^item\//, "")}.json`
      : `assets/${namespace}/models/item/${modelId.replace(/^item\//, "")}.json`,
    createItemDefinition: (modelId) => packFormat >= 55
      ? { model: { type: "minecraft:model", model: modelId } }
      : { parent: modelId },
  };
}

export function validatePackMeta(value: unknown): StudioProblem[] {
  if (!value || typeof value !== "object" || !("pack" in value)) return [{ severity: "error", code: "PACK_META_MISSING_PACK", message: "pack.mcmeta に pack objectがありません。", path: "pack.mcmeta" }];
  return [];
}
