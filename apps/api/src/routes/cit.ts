import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { VariantsCitProvider, type CitDocument, type CitRule } from "@mona/cit-core";
import type { Database } from "../db/pool.js";
import { requireUser } from "../auth.js";
import { AppError } from "../errors.js";
import { requireProjectPermission } from "../policy.js";
import { ProjectStorage } from "../services/storage.js";
import { assertPathsWritable } from "../services/locking.js";
import type { RealtimeHub } from "../services/realtime.js";

const paramsSchema = z.object({ projectId: z.string().uuid() });
const conditionSchema = z.object({
  kind: z.enum(["name", "lore", "custom_model_data", "enchantment", "damage", "component"]),
  operator: z.enum(["equals", "contains", "regex", "greater_than", "greater_or_equals", "smaller_than", "smaller_or_equals"]),
  value: z.string().max(2048), component: z.string().max(256).optional(),
});
const ruleSchema = z.object({
  id: z.string().regex(/^[a-z0-9_.-]+$/).max(128), sourcePath: z.string().max(1024).optional(),
  displayName: z.string().max(512), itemIds: z.array(z.string().max(160)).min(1).max(64),
  variantId: z.string().max(128), texture: z.string().max(512).optional(), model: z.string().max(512).optional(),
  modelPrefix: z.string().max(512).optional(), match: z.enum(["exact", "contains", "starts_with", "ends_with", "regex"]),
  conditions: z.array(conditionSchema).max(32).optional(),
});
const saveSchema = z.object({
  namespace: z.string().regex(/^[a-z0-9_.-]+$/).max(64), rules: z.array(ruleSchema).max(5000),
  baseVersions: z.record(z.string(), z.number().int().positive()).default({}),
});
const rawSchema = z.object({ path: z.string().min(1).max(1024), baseVersion: z.number().int().positive(), json: z.string().min(2).max(2 * 1024 * 1024) });

interface FileRow { id: string; path: string; current_version: number; sha256: string; size_bytes: string; }
const isCitPath = (path: string) => /^assets\/[a-z0-9_.-]+\/variants-cit\/.+\.json$/.test(path);
const publicRule = (rule: CitRule): CitRule => ({ ...rule, unknown: undefined, parameterUnknown: undefined });

async function loadDocument(db: Database, storage: ProjectStorage, projectId: string) {
  const project = await db.query<{ minecraft_version: string }>("SELECT minecraft_version FROM projects WHERE id = $1 AND archived_at IS NULL", [projectId]);
  if (!project.rows[0]) throw new AppError(404, "PROJECT_NOT_FOUND", "プロジェクトが見つかりません。");
  const rows = (await db.query<FileRow>("SELECT id,path,current_version,sha256,size_bytes FROM project_files WHERE project_id=$1 ORDER BY path", [projectId])).rows;
  const files = new Map<string, Uint8Array>();
  for (const row of rows.filter((entry) => isCitPath(entry.path))) files.set(row.path, await readFile(storage.resolveProjectFile(projectId, row.path)));
  const provider = new VariantsCitProvider(); const document = await provider.parse(files);
  const saved = await db.query<{ source_path: string; normalized: { rules?: CitRule[] } }>("SELECT source_path,normalized FROM cit_entries WHERE project_id=$1", [projectId]);
  const overlays = new Map<string, CitRule[]>();
  for (const row of saved.rows) if (Array.isArray(row.normalized?.rules)) overlays.set(row.source_path, row.normalized.rules);
  document.rules = document.rules.map((parsed) => {
    const overlay = overlays.get(parsed.sourcePath ?? "")?.find((entry) => entry.variantId === parsed.variantId && entry.displayName === parsed.displayName);
    return overlay ? { ...parsed, texture: overlay.texture, model: overlay.model, conditions: overlay.conditions ?? parsed.conditions } : parsed;
  });
  return { project: project.rows[0], rows, files, provider, document };
}

export async function citRoutes(app: FastifyInstance, db: Database, storage: ProjectStorage, realtime: RealtimeHub): Promise<void> {
  app.get("/projects/:projectId/cit", async (request) => {
    const user = await requireUser(request); const { projectId } = paramsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "project.read");
    const loaded = await loadDocument(db, storage, projectId); const paths = new Set(loaded.rows.map((row) => row.path));
    const rawFiles = [...loaded.files].map(([path, bytes]) => ({ path, version: loaded.rows.find((row) => row.path === path)?.current_version ?? 1, json: new TextDecoder().decode(bytes) }));
    return { provider: loaded.document.provider, namespace: loaded.document.namespace, minecraftVersion: loaded.project.minecraft_version, rules: loaded.document.rules.map(publicRule), problems: loaded.provider.validate(loaded.document, paths), baseVersions: Object.fromEntries(loaded.rows.filter((row) => isCitPath(row.path)).map((row) => [row.path, row.current_version])), rawFiles };
  });

  app.put("/projects/:projectId/cit", async (request) => {
    const user = await requireUser(request); const { projectId } = paramsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "file.write"); const body = saveSchema.parse(request.body);
    const loaded = await loadDocument(db, storage, projectId); const existingRules = loaded.document.rules;
    const rules: CitRule[] = body.rules.map((rule) => {
      const previous = existingRules.find((entry) => entry.sourcePath === rule.sourcePath && entry.variantId === rule.variantId);
      const sourcePath = rule.sourcePath || `assets/${body.namespace}/variants-cit/modules/${rule.id}.json`;
      if (!isCitPath(sourcePath)) throw new AppError(400, "CIT_PATH_INVALID", `Variants-CIT外のpathは保存できません: ${sourcePath}`);
      return { ...rule, sourcePath, unknown: previous?.unknown, parameterUnknown: previous?.parameterUnknown };
    });
    const document: CitDocument = { provider: loaded.provider.id, namespace: body.namespace, rules, unknownFiles: loaded.document.unknownFiles };
    const futurePaths = new Set(loaded.rows.map((row) => row.path)); const problems = loaded.provider.validate(document, futurePaths);
    const errors = problems.filter((problem) => problem.severity === "error"); if (errors.length) throw new AppError(400, "CIT_VALIDATION", "CIT設定にエラーがあります。", errors);
    const generated = await loaded.provider.generate(document); const currentCit = new Map(loaded.rows.filter((row) => isCitPath(row.path)).map((row) => [row.path, row]));
    for (const path of new Set([...currentCit.keys(), ...generated.keys()])) {
      const current = currentCit.get(path); if (current && body.baseVersions[path] !== current.current_version) throw new AppError(409, "FILE_VERSION_CONFLICT", `別のユーザーが ${path} を更新しました。再読み込みしてください。`, { path, currentVersion: current.current_version });
    }
    const client = await db.connect(); const restored: Array<{ path: string; bytes: Buffer }> = []; const created: string[] = []; let savedCount = 0; let deletedCount = 0;
    try {
      await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [projectId]); await assertPathsWritable(client, projectId, [...currentCit.keys()], user.sub);
      for (const [path, output] of generated) {
        const bytes = Buffer.from(output); const current = currentCit.get(path);
        if (current) {
          const oldBytes = Buffer.from(loaded.files.get(path)!); if (oldBytes.equals(bytes)) continue;
          const written = await storage.snapshotAndReplace(projectId, current.id, path, current.current_version, bytes); restored.push({ path, bytes: written.oldBytes }); const next = current.current_version + 1;
          await client.query("INSERT INTO file_versions(file_id,version,storage_key,sha256,size_bytes,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(file_id,version) DO NOTHING", [current.id, current.current_version, written.oldVersionKey, current.sha256, Number(current.size_bytes), user.sub]);
          await client.query("INSERT INTO file_versions(file_id,version,storage_key,sha256,size_bytes,created_by) VALUES($1,$2,$3,$4,$5,$6)", [current.id, next, written.newVersionKey, written.sha256, bytes.length, user.sub]);
          await client.query("UPDATE project_files SET size_bytes=$3,sha256=$4,current_version=$5,updated_by=$6,updated_at=now() WHERE project_id=$1 AND path=$2", [projectId, path, bytes.length, written.sha256, next, user.sub]); savedCount += 1;
        } else {
          const written = await storage.createWorkingFile(projectId, path, bytes); created.push(path);
          await client.query("INSERT INTO project_files(project_id,path,size_bytes,sha256,mime_type,updated_by) VALUES($1,$2,$3,$4,'application/json',$5)", [projectId, path, bytes.length, written.sha256, user.sub]); savedCount += 1;
        }
      }
      for (const [path, current] of currentCit) if (!generated.has(path)) {
        const oldBytes = await storage.removeWorkingFile(projectId, path); restored.push({ path, bytes: oldBytes }); await client.query("DELETE FROM project_files WHERE id=$1", [current.id]); deletedCount += 1;
      }
      await client.query("DELETE FROM cit_entries WHERE project_id=$1", [projectId]);
      const groups = new Map<string, CitRule[]>(); for (const rule of rules) { const group = groups.get(rule.sourcePath!) ?? []; group.push(publicRule(rule)); groups.set(rule.sourcePath!, group); }
      for (const [path, group] of groups) await client.query("INSERT INTO cit_entries(project_id,provider,source_path,normalized) VALUES($1,$2,$3,$4)", [projectId, loaded.provider.id, path, JSON.stringify({ rules: group })]);
      await client.query("UPDATE projects SET updated_at=now() WHERE id=$1", [projectId]);
      await client.query("INSERT INTO activity_logs(project_id,actor_id,action,target_type,target_id,metadata,ip,user_agent) VALUES($1::uuid,$2,'cit.saved','project',($1::uuid)::text,$3,$4,$5)", [projectId, user.sub, JSON.stringify({ rules: rules.length, saved: savedCount, deleted: deletedCount }), request.ip, request.headers["user-agent"] ?? null]);
      await client.query("COMMIT"); await realtime.publish(projectId, "cit.saved", { rules: rules.length, saved: savedCount, deleted: deletedCount }); return { rules: rules.length, saved: savedCount, deleted: deletedCount, problems };
    } catch (error) {
      await client.query("ROLLBACK");
      for (const path of created) await storage.discardWorkingFile(projectId, path).catch(() => undefined);
      for (const entry of restored.reverse()) await storage.restoreWorkingFile(projectId, entry.path, entry.bytes).catch(() => undefined);
      throw error;
    } finally { client.release(); }
  });

  app.put("/projects/:projectId/cit/raw", async (request) => {
    const user = await requireUser(request); const { projectId } = paramsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "file.write"); const body = rawSchema.parse(request.body);
    if (!isCitPath(body.path)) throw new AppError(400, "CIT_PATH_INVALID", "Variants-CIT JSONだけを編集できます。");
    let parsed: unknown; try { parsed = JSON.parse(body.json); } catch { throw new AppError(400, "JSON_PARSE", "JSONを解析できません。"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError(400, "JSON_OBJECT_REQUIRED", "CIT JSONのルートはObjectが必要です。");
    const client = await db.connect(); let oldBytes: Buffer | null = null;
    try {
      await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [projectId]); await assertPathsWritable(client, projectId, [body.path], user.sub); const result = await client.query<FileRow>("SELECT id,path,current_version,sha256,size_bytes FROM project_files WHERE project_id=$1 AND path=$2 FOR UPDATE", [projectId, body.path]); const file = result.rows[0];
      if (!file) throw new AppError(404, "FILE_NOT_FOUND", "CIT JSONが見つかりません。"); if (file.current_version !== body.baseVersion) throw new AppError(409, "FILE_VERSION_CONFLICT", "別のユーザーが先に保存しました。再読み込みしてください。", { currentVersion: file.current_version });
      const bytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`); const written = await storage.snapshotAndReplace(projectId, file.id, body.path, file.current_version, bytes); oldBytes = written.oldBytes; const next = file.current_version + 1;
      await client.query("INSERT INTO file_versions(file_id,version,storage_key,sha256,size_bytes,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(file_id,version) DO NOTHING", [file.id, file.current_version, written.oldVersionKey, file.sha256, Number(file.size_bytes), user.sub]);
      await client.query("INSERT INTO file_versions(file_id,version,storage_key,sha256,size_bytes,created_by) VALUES($1,$2,$3,$4,$5,$6)", [file.id, next, written.newVersionKey, written.sha256, bytes.length, user.sub]);
      await client.query("UPDATE project_files SET size_bytes=$3,sha256=$4,current_version=$5,updated_by=$6,updated_at=now() WHERE project_id=$1 AND path=$2", [projectId, body.path, bytes.length, written.sha256, next, user.sub]);
      await client.query("DELETE FROM cit_entries WHERE project_id=$1 AND source_path=$2", [projectId, body.path]);
      await client.query("INSERT INTO activity_logs(project_id,actor_id,action,target_type,target_id,metadata,ip,user_agent) VALUES($1,$2,'cit.raw_saved','file',$3,$4,$5,$6)", [projectId, user.sub, file.id, JSON.stringify({ path: body.path, version: next, sha256: createHash("sha256").update(bytes).digest("hex") }), request.ip, request.headers["user-agent"] ?? null]);
      await client.query("COMMIT"); await realtime.publish(projectId, "file.saved", { path: body.path, version: next }); return { path: body.path, version: next, size: bytes.length, sha256: written.sha256 };
    } catch (error) { await client.query("ROLLBACK"); if (oldBytes) await storage.restoreWorkingFile(projectId, body.path, oldBytes).catch(() => undefined); throw error; }
    finally { client.release(); }
  });
}
