import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ProjectFile, ProjectRole } from "@mona/shared";
import { hasPngSignature, readPngDimensions } from "@mona/minecraft-core";
import type { Database } from "../db/pool.js";
import { requireUser } from "../auth.js";
import { AppError } from "../errors.js";
import { requireProjectPermission } from "../policy.js";
import { importPack, ProjectStorage } from "../services/storage.js";
import { assertPathsWritable } from "../services/locking.js";
import type { RealtimeHub } from "../services/realtime.js";

const projectSchema = z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(2000).default(""), minecraftVersion: z.string().regex(/^\d+(?:\.\d+){1,2}$/).default("1.21.11") });
const paramsSchema = z.object({ projectId: z.string().uuid() });

function treeOf(rows: Array<{ path: string; size_bytes: string; mime_type: string | null; current_version: number }>): ProjectFile[] {
  const root: ProjectFile[] = [];
  for (const row of rows) {
    const parts = row.path.split("/"); let level = root; let current = "";
    parts.forEach((name, index) => {
      current = current ? `${current}/${name}` : name;
      const file = index === parts.length - 1;
      let node = level.find((entry) => entry.name === name);
      if (!node) { node = { path: current, name, kind: file ? "file" : "directory", size: file ? Number(row.size_bytes) : 0, mimeType: file ? row.mime_type : null, ...(file ? { version: row.current_version } : { children: [] }) }; level.push(node); }
      if (!file) level = node.children!;
    });
  }
  const sort = (nodes: ProjectFile[]) => { nodes.sort((a, b) => a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1); nodes.forEach((node) => node.children && sort(node.children)); };
  sort(root); return root;
}

export async function projectRoutes(app: FastifyInstance, db: Database, storage: ProjectStorage, realtime: RealtimeHub): Promise<void> {
  app.get("/projects", async (request) => {
    const user = await requireUser(request);
    const result = await db.query(
      `SELECT p.id, p.name, p.description, p.minecraft_version AS "minecraftVersion", pm.role,
              p.updated_at AS "updatedAt", count(pf.id)::int AS "fileCount"
       FROM projects p JOIN project_members pm ON pm.project_id = p.id LEFT JOIN project_files pf ON pf.project_id = p.id
       WHERE pm.user_id = $1 AND p.archived_at IS NULL GROUP BY p.id, pm.role ORDER BY p.updated_at DESC`, [user.sub],
    );
    if (user.systemRole === "admin") {
      return (await db.query(`SELECT p.id, p.name, p.description, p.minecraft_version AS "minecraftVersion", 'admin'::text AS role, p.updated_at AS "updatedAt", count(pf.id)::int AS "fileCount" FROM projects p LEFT JOIN project_files pf ON pf.project_id = p.id WHERE p.archived_at IS NULL GROUP BY p.id ORDER BY p.updated_at DESC`)).rows;
    }
    return result.rows;
  });

  app.post("/projects", async (request, reply) => {
    const user = await requireUser(request); const body = projectSchema.parse(request.body); const client = await db.connect();
    try {
      await client.query("BEGIN");
      const created = await client.query<{ id: string }>("INSERT INTO projects (name, description, minecraft_version, storage_key, created_by) VALUES ($1, $2, $3, gen_random_uuid()::text, $4) RETURNING id", [body.name, body.description, body.minecraftVersion, user.sub]);
      const id = created.rows[0]!.id;
      await client.query("UPDATE projects SET storage_key = $2 WHERE id = $1", [id, `projects/${id}/working`]);
      await client.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')", [id, user.sub]);
      await client.query("INSERT INTO activity_logs (project_id, actor_id, action, target_type, target_id, ip, user_agent) VALUES ($1::uuid, $2, 'project.created', 'project', ($1::uuid)::text, $3, $4)", [id, user.sub, request.ip, request.headers["user-agent"] ?? null]);
      await client.query("COMMIT"); await storage.ensure();
      reply.code(201); return { id, ...body, role: "owner", fileCount: 0, updatedAt: new Date().toISOString() };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  });

  app.get("/projects/:projectId", async (request) => {
    const user = await requireUser(request); const { projectId } = paramsSchema.parse(request.params); const role = await requireProjectPermission(db, user, projectId, "project.read");
    const result = await db.query("SELECT id, name, description, minecraft_version AS \"minecraftVersion\", updated_at AS \"updatedAt\" FROM projects WHERE id = $1 AND archived_at IS NULL", [projectId]);
    if (!result.rows[0]) throw new AppError(404, "PROJECT_NOT_FOUND", "プロジェクトが見つかりません。");
    return { ...result.rows[0], role };
  });

  app.post("/projects/:projectId/import", async (request) => {
    const user = await requireUser(request); const { projectId } = paramsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "project.import");
    const upload = await request.file({ limits: { files: 1, fileSize: 100 * 1024 * 1024 } });
    if (!upload) throw new AppError(400, "IMPORT_FILE_REQUIRED", "ZIPファイルを選択してください。");
    if (!upload.filename.toLowerCase().endsWith(".zip")) throw new AppError(400, "IMPORT_ZIP_ONLY", "ZIPファイルだけをImportできます。");
    const imported = await importPack(storage, projectId, await upload.toBuffer());
    const client = await db.connect().catch(async (error: unknown) => {
      try { await storage.rollbackInitialImport(projectId); } catch (rollbackError) { request.log.error({ rollbackError, projectId }, "failed to rollback import after database connection failure"); }
      throw error;
    });
    try {
      await client.query("BEGIN");
      for (const file of imported.files) await client.query("INSERT INTO project_files (project_id, path, size_bytes, sha256, mime_type, updated_by) VALUES ($1, $2, $3, $4, $5, $6)", [projectId, file.path, file.size, file.sha256, file.mimeType, user.sub]);
      await client.query("UPDATE projects SET updated_at = now() WHERE id = $1", [projectId]);
      await client.query("INSERT INTO activity_logs (project_id, actor_id, action, target_type, target_id, metadata, ip, user_agent) VALUES ($1::uuid, $2, 'pack.imported', 'project', ($1::uuid)::text, $3, $4, $5)", [projectId, user.sub, JSON.stringify(imported.report), request.ip, request.headers["user-agent"] ?? null]);
      await client.query("COMMIT"); await realtime.publish(projectId, "pack.imported", { files: imported.files.length }); return imported.report;
    } catch (error) {
      await client.query("ROLLBACK");
      try { await storage.rollbackInitialImport(projectId); } catch (rollbackError) { request.log.error({ rollbackError, projectId }, "failed to rollback imported files"); }
      throw error;
    } finally { client.release(); }
  });

  app.get("/projects/:projectId/files", async (request) => {
    const user = await requireUser(request); const { projectId } = paramsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "file.read");
    const result = await db.query<{ path: string; size_bytes: string; mime_type: string | null; current_version: number }>("SELECT path, size_bytes, mime_type, current_version FROM project_files WHERE project_id = $1 ORDER BY path", [projectId]);
    return { tree: treeOf(result.rows), count: result.rowCount ?? 0 };
  });

  app.post("/projects/:projectId/files/save", async (request) => {
    const user = await requireUser(request); const { projectId } = paramsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "file.write");
    let path = ""; let baseVersion = 0; let bytes: Buffer | null = null;
    for await (const part of request.parts({ limits: { files: 1, fileSize: 5 * 1024 * 1024, fields: 4 } })) {
      if (part.type === "file") { if (bytes) throw new AppError(400, "SINGLE_FILE_ONLY", "保存できるファイルは1つです。"); bytes = await part.toBuffer(); }
      else if (part.fieldname === "path") path = String(part.value);
      else if (part.fieldname === "baseVersion") baseVersion = Number(part.value);
    }
    if (!bytes || !path || !Number.isInteger(baseVersion) || baseVersion < 1) throw new AppError(400, "SAVE_FIELDS_REQUIRED", "path、baseVersion、fileが必要です。");
    if (!path.toLowerCase().endsWith(".png")) throw new AppError(400, "PHASE2_PNG_ONLY", "Phase 2の編集保存はPNGに対応しています。");
    if (!hasPngSignature(bytes)) throw new AppError(400, "PNG_SIGNATURE", "PNGシグネチャを確認できません。");
    const dimensions = readPngDimensions(bytes); if (dimensions.width !== dimensions.height || ![16, 32, 64].includes(dimensions.width)) throw new AppError(400, "PNG_DIMENSIONS", "編集可能なPNGサイズは16×16、32×32、64×64です。");
    const client = await db.connect(); let written: { oldBytes: Buffer; oldVersionKey: string; newVersionKey: string; sha256: string } | null = null;
    try {
      await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [projectId]); await assertPathsWritable(client, projectId, [path], user.sub);
      const result = await client.query<{ id: string; current_version: number; sha256: string; size_bytes: string }>("SELECT id, current_version, sha256, size_bytes FROM project_files WHERE project_id = $1 AND path = $2 FOR UPDATE", [projectId, path]);
      const file = result.rows[0]; if (!file) throw new AppError(404, "FILE_NOT_FOUND", "保存対象ファイルが見つかりません。");
      if (file.current_version !== baseVersion) throw new AppError(409, "FILE_VERSION_CONFLICT", "別のユーザーが先に保存しました。再読み込みしてください。", { currentVersion: file.current_version });
      written = await storage.snapshotAndReplace(projectId, file.id, path, file.current_version, bytes);
      const nextVersion = file.current_version + 1;
      await client.query("INSERT INTO file_versions (file_id, version, storage_key, sha256, size_bytes, created_by) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (file_id, version) DO NOTHING", [file.id, file.current_version, written.oldVersionKey, file.sha256, Number(file.size_bytes), user.sub]);
      await client.query("INSERT INTO file_versions (file_id, version, storage_key, sha256, size_bytes, created_by) VALUES ($1, $2, $3, $4, $5, $6)", [file.id, nextVersion, written.newVersionKey, written.sha256, bytes.length, user.sub]);
      await client.query("UPDATE project_files SET size_bytes = $3, sha256 = $4, current_version = $5, updated_by = $6, updated_at = now() WHERE project_id = $1 AND path = $2", [projectId, path, bytes.length, written.sha256, nextVersion, user.sub]);
      await client.query("UPDATE projects SET updated_at = now() WHERE id = $1", [projectId]);
      await client.query("INSERT INTO activity_logs (project_id, actor_id, action, target_type, target_id, metadata, ip, user_agent) VALUES ($1, $2, 'file.saved', 'file', $3, $4, $5, $6)", [projectId, user.sub, file.id, JSON.stringify({ path, version: nextVersion, sha256: written.sha256 }), request.ip, request.headers["user-agent"] ?? null]);
      await client.query("COMMIT"); await realtime.publish(projectId, "file.saved", { path, version: nextVersion }); return { path, version: nextVersion, size: bytes.length, sha256: written.sha256 };
    } catch (error) {
      await client.query("ROLLBACK"); if (written) try { await storage.restoreWorkingFile(projectId, path, written.oldBytes); } catch (rollbackError) { request.log.error({ rollbackError, projectId, path }, "failed to restore working file"); } throw error;
    } finally { client.release(); }
  });

  app.get("/projects/:projectId/files/content", async (request, reply) => {
    const user = await requireUser(request); const { projectId } = paramsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "file.read");
    const { path } = z.object({ path: z.string().min(1).max(1024) }).parse(request.query);
    const record = await db.query<{ mime_type: string | null; size_bytes: string }>("SELECT mime_type, size_bytes FROM project_files WHERE project_id = $1 AND path = $2", [projectId, path]);
    const file = record.rows[0]; if (!file) throw new AppError(404, "FILE_NOT_FOUND", "ファイルが見つかりません。");
    if (Number(file.size_bytes) > 5 * 1024 * 1024) throw new AppError(413, "PREVIEW_TOO_LARGE", "5MiBを超えるファイルはプレビューできません。");
    const bytes = await readFile(storage.resolveProjectFile(projectId, path));
    reply.type(file.mime_type ?? "application/octet-stream").header("Cache-Control", "private, no-store").send(bytes);
  });
}
