import type { StudioProblem } from "@mona/shared";

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();
const IDENTIFIER = /^(?:[a-z0-9_.-]+:)?[a-z0-9_./-]+$/;
const VARIANT_ID = /^[a-z0-9_.-]+$/;
const KNOWN_ROOT_FIELDS = new Set(["type", "items", "item", "modelPrefix", "parameters", "priority", "fallback", "assetGen", "modelParent", "hook", "precondition"]);
const KNOWN_PARAMETER_FIELDS = new Set(["componentType", "expect", "transform", "predicates"]);

export type CitMatch = "exact" | "contains" | "starts_with" | "ends_with" | "regex";
export type CitConditionKind = "name" | "lore" | "custom_model_data" | "enchantment" | "damage" | "component";
export type CitConditionOperator = "equals" | "contains" | "regex" | "greater_than" | "greater_or_equals" | "smaller_than" | "smaller_or_equals";

export interface CitCondition { kind: CitConditionKind; operator: CitConditionOperator; value: string; component?: string | undefined; }
export interface CitRule {
  id: string; sourcePath?: string | undefined; displayName: string; itemIds: string[]; variantId: string;
  texture?: string | undefined; model?: string | undefined; modelPrefix?: string | undefined; match: CitMatch; conditions?: CitCondition[] | undefined;
  unknown?: Record<string, unknown> | undefined; parameterUnknown?: Record<string, unknown> | undefined;
}
export interface CitDocument { provider: string; namespace: string; rules: CitRule[]; unknownFiles: Map<string, Uint8Array>; }
export interface CitProvider {
  readonly id: string;
  detect(paths: readonly string[]): boolean;
  parse(files: ReadonlyMap<string, Uint8Array>): Promise<CitDocument>;
  generate(document: CitDocument): Promise<Map<string, Uint8Array>>;
  validate(document: CitDocument, availablePaths?: ReadonlySet<string>): StudioProblem[];
  collectReferences(document: CitDocument): Set<string>;
}

function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function cloneObject(value: unknown): Record<string, unknown> { return isObject(value) ? structuredClone(value) : {}; }
function namespaced(value: string, namespace: string): string { return value.includes(":") ? value : `${namespace}:${value}`; }
function shortVariant(value: unknown): string { return String(value ?? "").replace(/^[^:]+:/, ""); }
function pathNamespace(path: string): string | null { return path.match(/^assets\/([^/]+)\/variants-cit\//)?.[1] ?? null; }
function ruleId(path: string, index: number): string {
  const base = path.split("/").pop()?.replace(/\.json$/i, "").toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "") || "cit";
  return index === 0 ? base : `${base}_${index + 1}`;
}
function normalizedItems(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.filter((entry): entry is string => typeof entry === "string" && entry.length > 0).map((entry) => entry.includes(":") ? entry : `minecraft:${entry}`);
}
function unknownFields(source: Record<string, unknown>, known: ReadonlySet<string>): Record<string, unknown> { return Object.fromEntries(Object.entries(source).filter(([key]) => !known.has(key))); }
function stableObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableObject);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableObject(value[key])]));
}
function stableJson(value: unknown): Uint8Array { return textEncoder.encode(`${JSON.stringify(stableObject(value), null, 2)}\n`); }

export function suggestedVariantId(displayName: string): string {
  return displayName.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_./-]/g, "").replace(/^_+|_+$/g, "");
}
export function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function transformForRule(rule: CitRule, namespace: string): Record<string, unknown> {
  const escaped = escapeRegex(rule.displayName);
  const regex = rule.match === "regex" ? rule.displayName : rule.match === "contains" ? `^.*${escaped}.*$` : rule.match === "starts_with" ? `^${escaped}.*$` : rule.match === "ends_with" ? `^.*${escaped}$` : `^${escaped}$`;
  return { function: "regex", regex, substitution: namespaced(rule.variantId, namespace), matchAll: true };
}
export function buildNameTransform(rules: readonly CitRule[], namespace: string): Record<string, unknown> {
  if (rules.every((rule) => rule.match === "exact")) return { function: "remap", map: Object.fromEntries(rules.map((rule) => [rule.displayName, namespaced(rule.variantId, namespace)])) };
  return { function: "alternative", alternatives: rules.map((rule) => transformForRule(rule, namespace)) };
}

function generatedRegex(transform: Record<string, unknown>): { displayName: string; match: CitMatch; variantId: string } | null {
  if (transform.function !== "regex" || typeof transform.regex !== "string" || typeof transform.substitution !== "string") return null;
  const patterns: Array<[CitMatch, RegExp]> = [["contains", /^\^\.\*(.*)\.\*\$$/], ["starts_with", /^\^(.*)\.\*\$$/], ["ends_with", /^\^\.\*(.*)\$$/], ["exact", /^\^(.*)\$$/]];
  for (const [match, pattern] of patterns) {
    const found = transform.regex.match(pattern); if (!found) continue;
    const encoded = found[1]!; const unescapedRemainder = encoded.replace(/\\[.*+?^${}()|[\]\\]/g, "");
    if (/[.*+?^${}()|[\]\\]/.test(unescapedRemainder)) break;
    return { displayName: encoded.replace(/\\([.*+?^${}()|[\]\\])/g, "$1"), match, variantId: shortVariant(transform.substitution) };
  }
  return { displayName: transform.regex, match: "regex", variantId: shortVariant(transform.substitution) };
}
function parseNameTransform(transform: unknown): Array<{ displayName: string; match: CitMatch; variantId: string }> {
  if (!isObject(transform)) return [];
  if (transform.function === "remap" && isObject(transform.map)) return Object.entries(transform.map).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([displayName, variantId]) => ({ displayName, match: "exact", variantId: shortVariant(variantId) }));
  if (transform.function === "alternative" && Array.isArray(transform.alternatives)) return transform.alternatives.map((row) => isObject(row) ? generatedRegex(row) : null).filter((row): row is NonNullable<typeof row> => Boolean(row));
  const one = generatedRegex(transform); return one ? [one] : [];
}

function conditionProperty(condition: CitCondition): string {
  if (condition.kind === "name") return "custom_name";
  if (condition.kind === "lore") return "lore";
  if (condition.kind === "custom_model_data") return "custom_model_data";
  if (condition.kind === "enchantment") return "enchantments";
  if (condition.kind === "damage") return "damage";
  return condition.component?.trim() || "custom_data";
}
function conditionValue(condition: CitCondition): unknown {
  const numeric = condition.kind === "custom_model_data" || condition.kind === "damage" || ["greater_than", "greater_or_equals", "smaller_than", "smaller_or_equals"].includes(condition.operator);
  const value: unknown = numeric && condition.value.trim() !== "" && Number.isFinite(Number(condition.value)) ? Number(condition.value) : condition.value;
  if (condition.operator === "equals") return value;
  if (condition.operator === "contains") return { function: "regex", regex: `^.*${escapeRegex(String(value))}.*$` };
  if (condition.operator === "regex") return { function: "regex", regex: String(value) };
  return { [condition.operator]: value };
}
function conditionsToPrecondition(conditions: readonly CitCondition[]): Record<string, unknown> { return Object.fromEntries(conditions.map((condition) => [conditionProperty(condition), conditionValue(condition)])); }
function preconditionToConditions(precondition: unknown): CitCondition[] {
  if (!isObject(precondition)) return [];
  return Object.entries(precondition).map(([component, raw]) => {
    const kind: CitConditionKind = component === "custom_name" || component === "item_name" ? "name" : component === "lore" ? "lore" : component === "custom_model_data" ? "custom_model_data" : component === "enchantments" ? "enchantment" : component === "damage" ? "damage" : "component";
    if (isObject(raw)) {
      if (raw.function === "regex") return { kind, component, operator: "regex", value: String(raw.regex ?? "") };
      const [operator, value] = Object.entries(raw)[0] ?? ["equals", ""];
      return { kind, component, operator: operator as CitConditionOperator, value: String(value) };
    }
    return { kind, component, operator: "equals", value: String(raw) };
  });
}

function parseModule(path: string, config: Record<string, unknown>): CitRule[] | null {
  const items = normalizedItems(config.items ?? config.item); const parameters = cloneObject(config.parameters);
  const common = { sourcePath: path, itemIds: items, modelPrefix: typeof config.modelPrefix === "string" ? config.modelPrefix : undefined, unknown: unknownFields(config, KNOWN_ROOT_FIELDS), parameterUnknown: unknownFields(parameters, KNOWN_PARAMETER_FIELDS) };
  if (config.type === "component_data" && (parameters.componentType === "custom_name" || parameters.componentType === "item_name")) {
    const rows = parseNameTransform(parameters.transform); if (!rows.length) return null;
    return rows.map((row, index) => ({ id: ruleId(path, index), ...common, displayName: row.displayName, variantId: row.variantId, match: row.match, conditions: [{ kind: "name", operator: row.match === "exact" ? "equals" : row.match === "regex" ? "regex" : "contains", value: row.displayName }] }));
  }
  if (config.type === "predicates" && Array.isArray(parameters.predicates)) {
    return parameters.predicates.filter(isObject).map((row, index) => {
      const conditions = preconditionToConditions(row.precondition); const displayName = conditions.find((condition) => condition.kind === "name")?.value ?? shortVariant(row.variantId ?? row.modelId);
      return { id: ruleId(path, index), ...common, displayName, variantId: shortVariant(row.variantId ?? row.modelId), match: "exact", conditions };
    });
  }
  return null;
}
function groupOutputPath(rule: CitRule, namespace: string): string { return rule.sourcePath || `assets/${namespace}/variants-cit/modules/${rule.id}.json`; }
function groupConfig(rules: readonly CitRule[], namespace: string): Record<string, unknown> {
  const first = rules[0]!; const root = { ...(first.unknown ?? {}) }; const extraConditions = rules.some((rule) => (rule.conditions ?? []).some((condition) => condition.kind !== "name"));
  if (extraConditions) return { ...root, type: "predicates", items: first.itemIds.length === 1 ? first.itemIds[0] : first.itemIds, ...(first.modelPrefix ? { modelPrefix: first.modelPrefix } : {}), parameters: { ...(first.parameterUnknown ?? {}), predicates: rules.map((rule) => ({ variantId: namespaced(rule.variantId, namespace), precondition: conditionsToPrecondition(rule.conditions?.length ? rule.conditions : [{ kind: "name", operator: "equals", value: rule.displayName }]) })) } };
  return { ...root, type: "component_data", items: first.itemIds.length === 1 ? first.itemIds[0] : first.itemIds, ...(first.modelPrefix ? { modelPrefix: first.modelPrefix } : {}), parameters: { ...(first.parameterUnknown ?? {}), componentType: "custom_name", expect: "rich_text", transform: buildNameTransform(rules, namespace) } };
}

function referencePath(reference: string, kind: "texture" | "model", fallbackNamespace: string): string {
  const [namespace, rawPath] = reference.includes(":") ? reference.split(":", 2) as [string, string] : [fallbackNamespace, reference];
  const path = rawPath.replace(/^\/+/, "").replace(kind === "texture" ? /^textures\// : /^models\//, "").replace(kind === "texture" ? /\.png$/ : /\.json$/, "");
  return `assets/${namespace}/${kind === "texture" ? "textures" : "models"}/${path}.${kind === "texture" ? "png" : "json"}`;
}
function conditionSignature(rule: CitRule): string {
  const conditions = rule.conditions?.length ? rule.conditions : [{ kind: "name", operator: rule.match, value: rule.displayName }];
  return JSON.stringify(stableObject({ items: [...rule.itemIds].sort(), conditions }));
}
export function detectConflicts(document: CitDocument): StudioProblem[] {
  const problems: StudioProblem[] = []; const exact = new Map<string, CitRule>();
  for (const rule of document.rules) { const signature = conditionSignature(rule); const previous = exact.get(signature); if (previous) problems.push({ severity: "error", code: "CIT_CONFLICT", message: `${rule.id} と ${previous.id} の対象・条件が完全一致しています。`, path: rule.sourcePath }); else exact.set(signature, rule); }
  for (let leftIndex = 0; leftIndex < document.rules.length; leftIndex += 1) for (let rightIndex = leftIndex + 1; rightIndex < document.rules.length; rightIndex += 1) {
    const left = document.rules[leftIndex]!; const right = document.rules[rightIndex]!; if (!left.itemIds.some((item) => right.itemIds.includes(item)) || left.displayName === right.displayName) continue;
    const overlaps = (left.match === "contains" && right.displayName.includes(left.displayName)) || (right.match === "contains" && left.displayName.includes(right.displayName));
    if (overlaps) problems.push({ severity: "warning", code: "CIT_PARTIAL_CONFLICT", message: `${left.id} と ${right.id} は名前条件が重なる可能性があります。`, path: right.sourcePath });
  }
  return problems;
}
export function validateReferences(document: CitDocument, availablePaths: ReadonlySet<string>): StudioProblem[] {
  const normalized = new Map([...availablePaths].map((path) => [path.toLocaleLowerCase("en-US"), path])); const problems: StudioProblem[] = [];
  for (const rule of document.rules) for (const [kind, reference] of [["texture", rule.texture], ["model", rule.model]] as const) {
    if (!reference) continue; const expected = referencePath(reference, kind, document.namespace); const actual = normalized.get(expected.toLocaleLowerCase("en-US"));
    if (!actual) problems.push({ severity: "error", code: "CIT_MISSING_REFERENCE", message: `${kind === "texture" ? "Texture" : "Model"}参照が見つかりません: ${reference}`, path: rule.sourcePath, hint: expected });
    else if (actual !== expected) problems.push({ severity: "warning", code: "CIT_REFERENCE_CASE", message: `参照の大文字・小文字が一致しません: ${reference}`, path: rule.sourcePath, hint: actual });
  }
  return problems;
}

export function generateGiveCommand(rule: CitRule, _minecraftVersion = "1.21.11", target = "@s"): string {
  const item = rule.itemIds[0] || "minecraft:stone"; const components: string[] = [];
  const conditions = rule.conditions?.length ? rule.conditions : [{ kind: "name" as const, operator: "equals" as const, value: rule.displayName }];
  const name = conditions.find((condition) => condition.kind === "name");
  if (name?.value) { const json = JSON.stringify({ text: name.value, italic: false }).replaceAll("\\", "\\\\").replaceAll("'", "\\'"); components.push(`minecraft:custom_name='${json}'`); }
  const customModelData = conditions.find((condition) => condition.kind === "custom_model_data"); if (customModelData?.value && Number.isFinite(Number(customModelData.value))) components.push(`minecraft:custom_model_data=${Number(customModelData.value)}`);
  const damage = conditions.find((condition) => condition.kind === "damage"); if (damage?.value && Number.isFinite(Number(damage.value))) components.push(`minecraft:damage=${Number(damage.value)}`);
  const lore = conditions.filter((condition) => condition.kind === "lore").map((condition) => JSON.stringify({ text: condition.value, italic: false }));
  if (lore.length) components.push(`minecraft:lore=[${lore.map((line) => `'${line.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`).join(",")}]`);
  return `/give ${target} ${item}${components.length ? `[${components.join(",")}]` : ""} 1`;
}

export class VariantsCitProvider implements CitProvider {
  readonly id = "variants-cit-v5";
  detect(paths: readonly string[]): boolean { return paths.some((path) => path.includes("/variants-cit/") && path.endsWith(".json")); }
  async parse(files: ReadonlyMap<string, Uint8Array>): Promise<CitDocument> {
    const rules: CitRule[] = []; const unknownFiles = new Map<string, Uint8Array>(); let namespace = "monaka";
    for (const [path, bytes] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
      const detectedNamespace = pathNamespace(path); if (detectedNamespace) namespace = detectedNamespace;
      if (!detectedNamespace || !path.endsWith(".json")) { unknownFiles.set(path, bytes.slice()); continue; }
      try { const parsed: unknown = JSON.parse(textDecoder.decode(bytes)); if (!isObject(parsed)) { unknownFiles.set(path, bytes.slice()); continue; } const moduleRules = parseModule(path, parsed); if (!moduleRules?.length) unknownFiles.set(path, bytes.slice()); else rules.push(...moduleRules); }
      catch { unknownFiles.set(path, bytes.slice()); }
    }
    return { provider: this.id, namespace, rules, unknownFiles };
  }
  async generate(document: CitDocument): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>([...document.unknownFiles].map(([path, bytes]) => [path, bytes.slice()])); const groups = new Map<string, CitRule[]>();
    for (const rule of document.rules) { const path = groupOutputPath(rule, document.namespace); const group = groups.get(path) ?? []; group.push(rule); groups.set(path, group); }
    for (const [path, rules] of [...groups].sort(([left], [right]) => left.localeCompare(right))) files.set(path, stableJson(groupConfig(rules, document.namespace)));
    return files;
  }
  validate(document: CitDocument, availablePaths?: ReadonlySet<string>): StudioProblem[] {
    const seen = new Set<string>(); const variants = new Set<string>(); const problems: StudioProblem[] = [];
    if (!/^[a-z0-9_.-]+$/.test(document.namespace)) problems.push({ severity: "error", code: "CIT_NAMESPACE", message: `無効なNamespace: ${document.namespace}` });
    for (const rule of document.rules) {
      if (!VARIANT_ID.test(rule.variantId)) problems.push({ severity: "error", code: "CIT_VARIANT_ID", message: `無効なVariant ID: ${rule.variantId}`, path: rule.sourcePath });
      if (!rule.displayName.trim()) problems.push({ severity: "error", code: "CIT_NAME_REQUIRED", message: "アイテム名を入力してください。", path: rule.sourcePath });
      if (!rule.itemIds.length || rule.itemIds.some((item) => !IDENTIFIER.test(item))) problems.push({ severity: "error", code: "CIT_ITEM_ID", message: `Target Itemが不正です: ${rule.itemIds.join(", ") || "(empty)"}`, path: rule.sourcePath });
      if (seen.has(rule.id)) problems.push({ severity: "error", code: "CIT_DUPLICATE_ID", message: `Rule IDが重複しています: ${rule.id}`, path: rule.sourcePath }); seen.add(rule.id);
      if (variants.has(rule.variantId)) problems.push({ severity: "error", code: "CIT_DUPLICATE_VARIANT", message: `Variant IDが重複しています: ${rule.variantId}`, path: rule.sourcePath }); variants.add(rule.variantId);
      if (rule.match === "regex") try { new RegExp(rule.displayName); } catch { problems.push({ severity: "error", code: "CIT_REGEX", message: `正規表現が不正です: ${rule.displayName}`, path: rule.sourcePath }); }
      for (const condition of rule.conditions ?? []) if (condition.kind === "component" && !condition.component?.trim()) problems.push({ severity: "error", code: "CIT_COMPONENT_REQUIRED", message: "その他ComponentのIDを入力してください。", path: rule.sourcePath });
    }
    problems.push(...detectConflicts(document)); if (availablePaths) problems.push(...validateReferences(document, availablePaths)); return problems;
  }
  collectReferences(document: CitDocument): Set<string> { return new Set(document.rules.flatMap((rule) => [rule.texture, rule.model].filter((value): value is string => Boolean(value)))); }
}
