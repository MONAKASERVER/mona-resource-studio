import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Braces, Clipboard, FileJson, Plus, Save, Sparkles, Trash2, X } from "lucide-react";
import { generateGiveCommand, suggestedVariantId, type CitCondition, type CitConditionKind, type CitRule } from "@mona/cit-core";
import type { StudioProblem } from "@mona/shared";
import type { CitWorkspace, StudioApi } from "./api.js";

const emptyRule = (): CitRule => ({
  id: `cit_${Date.now().toString(36)}`, displayName: "", itemIds: ["minecraft:ghast_tear"], variantId: "new_variant", match: "exact",
  modelPrefix: "item/custom/", conditions: [{ kind: "name", operator: "equals", value: "" }],
});
const cloneRule = (rule: CitRule): CitRule => structuredClone(rule);
const messageOf = (error: unknown) => error instanceof Error ? error.message : "処理に失敗しました。";
const conditionLabel: Record<CitConditionKind, string> = { name: "アイテム名", lore: "Lore", custom_model_data: "CustomModelData", enchantment: "Enchantment", damage: "Damage", component: "その他Component" };

export function CitManager({ api, projectId, minecraftVersion, onProblems, onChanged }: { api: StudioApi; projectId: string; minecraftVersion: string; onProblems: (problems: StudioProblem[]) => void; onChanged: () => void }) {
  const [workspace, setWorkspace] = useState<CitWorkspace | null>(null); const [selectedId, setSelectedId] = useState(""); const [draft, setDraft] = useState<CitRule | null>(null);
  const [tab, setTab] = useState<"gui" | "raw">("gui"); const [rawPath, setRawPath] = useState(""); const [rawText, setRawText] = useState(""); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState("");
  const load = async (preferId?: string) => {
    setBusy(true); setNotice("");
    try {
      const next = await api.listCit(projectId); setWorkspace(next); onProblems(next.problems);
      const selected = next.rules.find((rule) => rule.id === (preferId ?? selectedId)) ?? next.rules[0] ?? null; setSelectedId(selected?.id ?? ""); setDraft(selected ? cloneRule(selected) : null);
      const raw = next.rawFiles.find((file) => file.path === rawPath) ?? next.rawFiles[0]; setRawPath(raw?.path ?? ""); setRawText(raw?.json ?? "");
    } catch (error) { setNotice(messageOf(error)); } finally { setBusy(false); }
  };
  useEffect(() => { void load(); }, [projectId]);
  const selectRule = (rule: CitRule) => { setSelectedId(rule.id); setDraft(cloneRule(rule)); setTab("gui"); setNotice(""); };
  const createRule = () => { const next = emptyRule(); setSelectedId(next.id); setDraft(next); setTab("gui"); setNotice("新規CITを編集中です。保存するとJSONを生成します。"); };
  const commitRules = async (nextRules: CitRule[], selected: string) => {
    if (!workspace) return; setBusy(true); setNotice("");
    try { const result = await api.saveCit(projectId, { namespace: workspace.namespace, rules: nextRules, baseVersions: workspace.baseVersions }); setNotice(`${result.saved}ファイルを保存しました。`); onProblems(result.problems); onChanged(); await load(selected); }
    catch (error) { setNotice(messageOf(error)); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!workspace || !draft) return;
    const name = draft.displayName.trim(); const variantId = draft.variantId.trim() || suggestedVariantId(name);
    const normalized = { ...draft, displayName: name, variantId, itemIds: draft.itemIds.map((item) => item.trim()).filter(Boolean), conditions: (draft.conditions ?? []).map((condition) => condition.kind === "name" ? { ...condition, value: name, operator: draft.match === "exact" ? "equals" as const : draft.match === "regex" ? "regex" as const : "contains" as const } : condition) };
    const exists = workspace.rules.some((rule) => rule.id === normalized.id); const rules = exists ? workspace.rules.map((rule) => rule.id === normalized.id ? normalized : rule) : [...workspace.rules, normalized]; await commitRules(rules, normalized.id);
  };
  const remove = async () => { if (!workspace || !draft) return; if (!window.confirm(`「${draft.displayName || draft.id}」を削除しますか？`)) return; await commitRules(workspace.rules.filter((rule) => rule.id !== draft.id), ""); };
  const updateCondition = (index: number, patch: Partial<CitCondition>) => setDraft((current) => current ? { ...current, conditions: (current.conditions ?? []).map((condition, row) => row === index ? { ...condition, ...patch } : condition) } : current);
  const addCondition = (kind: CitConditionKind) => setDraft((current) => current ? { ...current, conditions: [...(current.conditions ?? []), { kind, operator: "equals", value: "", ...(kind === "component" ? { component: "minecraft:custom_data" } : {}) }] } : current);
  const chooseRaw = (path: string) => { const file = workspace?.rawFiles.find((entry) => entry.path === path); setRawPath(path); setRawText(file?.json ?? ""); };
  const saveRaw = async () => {
    const file = workspace?.rawFiles.find((entry) => entry.path === rawPath); if (!file) return; setBusy(true); setNotice("");
    try { await api.saveCitRaw(projectId, { path: file.path, baseVersion: file.version, json: rawText }); setNotice("Raw JSONを保存しました。"); onChanged(); await load(); }
    catch (error) { setNotice(messageOf(error)); } finally { setBusy(false); }
  };
  const command = useMemo(() => draft ? generateGiveCommand(draft, minecraftVersion) : "", [draft, minecraftVersion]);
  if (!workspace) return <div className="cit-loading">{busy ? "CITを解析しています…" : notice || "CITを読み込めませんでした。"}</div>;
  return <div className="cit-manager">
    <aside className="cit-list"><header><div><span className="eyebrow">VARIANTS-CIT V5</span><strong>{workspace.rules.length} RULES</strong></div><button title="CITを追加" onClick={createRule}><Plus /></button></header><label className="cit-namespace">Namespace<input value={workspace.namespace} onChange={(event) => setWorkspace({ ...workspace, namespace: event.target.value })} /></label><div>{workspace.rules.map((rule) => <button className={selectedId === rule.id ? "active" : ""} key={rule.id} onClick={() => selectRule(rule)}><Sparkles /><span><strong>{rule.displayName || "名称未設定"}</strong><small>{rule.itemIds.join(", ")}</small></span></button>)}{workspace.rules.length === 0 && <div className="cit-empty">CITはまだありません。<br />＋から作成できます。</div>}</div></aside>
    <section className="cit-editor"><header><div className="cit-tabs"><button className={tab === "gui" ? "active" : ""} onClick={() => setTab("gui")}><Sparkles />GUI Editor</button><button className={tab === "raw" ? "active" : ""} onClick={() => setTab("raw")}><Braces />Advanced JSON</button></div>{tab === "gui" ? <div className="cit-actions"><button className="danger-subtle" onClick={() => void remove()} disabled={!draft || busy}><Trash2 />削除</button><button className="primary" onClick={() => void save()} disabled={!draft || busy}><Save />{busy ? "保存中…" : "保存"}</button></div> : <button className="primary" onClick={() => void saveRaw()} disabled={!rawPath || busy}><Save />Raw JSONを保存</button>}</header>
      {tab === "gui" ? draft ? <div className="cit-form"><section><h3>基本設定</h3><div className="cit-grid"><label>Rule ID<input value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value.toLowerCase() })} /></label><label>Variant ID<input value={draft.variantId} onChange={(event) => setDraft({ ...draft, variantId: event.target.value.toLowerCase() })} /></label><label className="wide">Target Item <span title="CITを適用するMinecraft Item IDです。">ⓘ</span><input value={draft.itemIds.join(", ")} onChange={(event) => setDraft({ ...draft, itemIds: event.target.value.split(",") })} placeholder="minecraft:ghast_tear" /></label><label>名前の判定<select value={draft.match} onChange={(event) => setDraft({ ...draft, match: event.target.value as CitRule["match"] })}><option value="exact">完全一致</option><option value="contains">部分一致</option><option value="starts_with">前方一致</option><option value="ends_with">後方一致</option><option value="regex">正規表現</option></select></label><label>modelPrefix<input value={draft.modelPrefix ?? ""} onChange={(event) => setDraft({ ...draft, modelPrefix: event.target.value })} placeholder="item/custom/" /></label></div></section>
        <section><h3>条件</h3><div className="condition-list">{(draft.conditions ?? []).map((condition, index) => <article key={`${condition.kind}-${index}`}><header><strong>{conditionLabel[condition.kind]}</strong><button onClick={() => setDraft({ ...draft, conditions: draft.conditions?.filter((_, row) => row !== index) })}><X /></button></header>{condition.kind === "component" && <input value={condition.component ?? ""} onChange={(event) => updateCondition(index, { component: event.target.value })} placeholder="minecraft:custom_data" />}<div><select value={condition.operator} onChange={(event) => updateCondition(index, { operator: event.target.value as CitCondition["operator"] })}><option value="equals">一致</option><option value="contains">含む</option><option value="regex">正規表現</option><option value="greater_than">より大きい</option><option value="smaller_or_equals">以下</option></select><input value={condition.kind === "name" ? draft.displayName : condition.value} onChange={(event) => condition.kind === "name" ? setDraft({ ...draft, displayName: event.target.value }) : updateCondition(index, { value: event.target.value })} placeholder={conditionLabel[condition.kind]} /></div></article>)}</div><div className="condition-add">{(["name", "lore", "custom_model_data", "enchantment", "damage", "component"] as CitConditionKind[]).map((kind) => <button key={kind} onClick={() => addCondition(kind)}>＋ {conditionLabel[kind]}</button>)}</div></section>
        <section><h3>参照とテスト</h3><div className="cit-grid"><label>Texture参照<input value={draft.texture ?? ""} onChange={(event) => setDraft({ ...draft, texture: event.target.value })} placeholder="monaka:item/dark_tear" /></label><label>Model参照<input value={draft.model ?? ""} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="monaka:item/dark_tear" /></label></div><div className="cit-preview"><span>このCITは以下の場合に適用されます。</span><strong>{draft.itemIds.filter(Boolean).join(", ") || "Target未設定"}</strong><p>{draft.displayName || "アイテム名未設定"} → <code>{workspace.namespace}:{draft.variantId}</code></p></div><div className="command-output"><code>{command}</code><button onClick={() => void navigator.clipboard.writeText(command).then(() => setNotice("Give Commandをコピーしました。"))}><Clipboard />コピー</button></div></section></div> : <div className="cit-empty large">左の＋からCITを作成してください。</div>
      : <div className="raw-editor"><div className="raw-file-tabs">{workspace.rawFiles.map((file) => <button className={file.path === rawPath ? "active" : ""} key={file.path} onClick={() => chooseRaw(file.path)}><FileJson />{file.path.split("/").pop()}</button>)}</div>{rawPath ? <><div className="raw-path">{rawPath}</div><textarea spellCheck={false} value={rawText} onChange={(event) => setRawText(event.target.value)} /></> : <div className="cit-empty large">保存済みのCIT JSONがありません。</div>}</div>}
      {notice && <div className={`cit-notice ${notice.includes("失敗") || notice.includes("エラー") ? "error" : ""}`}><AlertCircle />{notice}</div>}
    </section>
  </div>;
}
