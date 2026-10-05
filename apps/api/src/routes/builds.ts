import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { decodePackArchive, type SnapshotManifest } from "@mona/build-core";
import type { Database } from "../db/pool.js";
import { requireUser } from "../auth.js";
import { AppError } from "../errors.js";
import { requireProjectPermission } from "../policy.js";
import { BuildServices, captureSnapshot, queueBuild } from "../services/builds.js";
import { mimeFor, ProjectStorage } from "../services/storage.js";
import type { RealtimeHub } from "../services/realtime.js";

const paramsSchema = z.object({ projectId: z.string().uuid() });
const idParamsSchema = z.object({ projectId: z.string().uuid(), id: z.string().uuid() });
const snapshotInput = z.object({ label: z.string().trim().min(1).max(120) });
const buildInput = z.object({ profile: z.enum(["development", "release"]).default("development"), label: z.string().trim().min(1).max(120).optional(), snapshotId: z.string().uuid().optional() });

const buildColumns = `b.id, b.snapshot_id AS "snapshotId", b.status, b.profile, b.progress, b.artifact_sha256 AS "artifactSha256", b.artifact_size::text AS "artifactSize", b.error_code AS "errorCode", b.created_at AS "createdAt", b.started_at AS "startedAt", b.finished_at AS "finishedAt", s.label AS "snapshotLabel"`;
const buildSelect = `SELECT ${buildColumns} FROM build_jobs b JOIN snapshots s ON s.id = b.snapshot_id`;

export async function buildRoutes(app: FastifyInstance, db: Database, storage: ProjectStorage, services: BuildServices, realtime: RealtimeHub): Promise<void> {
  app.get("/projects/:projectId/snapshots", async (request) => {
    const user = await requireUser(request); const { projectId } = paramsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "project.read");
    const result = await db.query(`SELECT s.id, s.label, s.manifest, s.created_at AS "createdAt", u.display_name AS "createdBy" FROM snapshots s JOIN users u ON u.id = s.created_by WHERE s.project_id = $1 ORDER BY s.created_at DESC LIMIT 100`, [projectId]); return result.rows;
  });

  app.post("/projects/:projectId/snapshots", async (request, reply) => {
    const user = await requireUser(request); const { projectId } = paramsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "build.run"); const body = snapshotInput.parse(request.body);
    const snapshot = await captureSnapshot(db, storage, services, { projectId, userId: user.sub, label: body.label });
    await db.query("INSERT INTO activity_logs (project_id, actor_id, action, target_type, target_id, metadata, ip, user_agent) VALUES ($1, $2, 'snapshot.created', 'snapshot', $3, $4, $5, $6)", [projectId, user.sub, snapshot.id, JSON.stringify({ label: body.label, files: snapshot.manifest.files.length }), request.ip, request.headers["user-agent"] ?? null]);
    reply.code(201); return snapshot;
  });

  app.post("/projects/:projectId/snapshots/:id/rollback", async (request) => {
    const user = await requireUser(request); const { projectId, id } = idParamsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "build.run");
    const active = await db.query("SELECT 1 FROM build_jobs WHERE project_id = $1 AND status IN ('queued', 'running') LIMIT 1", [projectId]); if (active.rowCount) throw new AppError(409, "BUILD_ACTIVE", "Build実行中はRollbackできません。");
    const result = await db.query<{ manifest: SnapshotManifest; artifact_key: string | null }>("SELECT manifest, artifact_key FROM snapshots WHERE id = $1 AND project_id = $2", [id, projectId]); const snapshot = result.rows[0];
    if (!snapshot?.artifact_key) throw new AppError(404, "SNAPSHOT_NOT_FOUND", "復元可能なSnapshotが見つかりません。");
    const files = decodePackArchive(await services.objects.get(snapshot.artifact_key)); const expected = new Map(snapshot.manifest.files.map((file) => [file.path, file]));
    if (files.size !== expected.size) throw new AppError(409, "SNAPSHOT_CORRUPT", "Snapshotのファイル数がManifestと一致しません。");
    for (const [path, bytes] of files) { const record = expected.get(path); if (!record || record.size !== bytes.length || record.sha256 !== createHash("sha256").update(bytes).digest("hex")) throw new AppError(409, "SNAPSHOT_CORRUPT", `Snapshotの整合性検証に失敗しました: ${path}`); }
    const swap = await storage.replaceWorkingTree(projectId, files); const client = await db.connect();
    try {
      await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [projectId]);
      const paths = [...files.keys()];
      if (paths.length) await client.query("DELETE FROM project_files WHERE project_id = $1 AND NOT (path = ANY($2::text[]))", [projectId, paths]); else await client.query("DELETE FROM project_files WHERE project_id = $1", [projectId]);
      for (const file of snapshot.manifest.files) await client.query(`INSERT INTO project_files (project_id, path, size_bytes, sha256, mime_type, current_version, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, 1, $6, now()) ON CONFLICT (project_id, path) DO UPDATE SET size_bytes = EXCLUDED.size_bytes, sha256 = EXCLUDED.sha256, mime_type = EXCLUDED.mime_type, current_version = project_files.current_version + 1, updated_by = EXCLUDED.updated_by, updated_at = now()`, [projectId, file.path, file.size, file.sha256, file.mimeType ?? mimeFor(file.path), user.sub]);
      await client.query("UPDATE projects SET updated_at = now() WHERE id = $1", [projectId]);
      await client.query("INSERT INTO activity_logs (project_id, actor_id, action, target_type, target_id, metadata, ip, user_agent) VALUES ($1, $2, 'snapshot.rolled_back', 'snapshot', $3, $4, $5, $6)", [projectId, user.sub, id, JSON.stringify({ files: files.size }), request.ip, request.headers["user-agent"] ?? null]);
      await client.query("COMMIT"); await swap.commit(); return { snapshotId: id, restoredFiles: files.size };
    } catch (error) { await client.query("ROLLBACK"); await swap.rollback(); throw error; } finally { client.release(); }
  });

  app.get("/projects/:projectId/builds", async (request) => {
    const user = await requireUser(request); const { projectId } = paramsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "project.read"); return (await db.query(`${buildSelect} WHERE b.project_id = $1 ORDER BY b.created_at DESC LIMIT 100`, [projectId])).rows;
  });

  app.post("/projects/:projectId/builds", async (request, reply) => {
    const user = await requireUser(request); const { projectId } = paramsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "build.run"); const body = buildInput.parse(request.body);
    let snapshotId = body.snapshotId;
    if (snapshotId) { const found = await db.query("SELECT 1 FROM snapshots WHERE id = $1 AND project_id = $2", [snapshotId, projectId]); if (!found.rowCount) throw new AppError(404, "SNAPSHOT_NOT_FOUND", "Snapshotが見つかりません。"); }
    else snapshotId = (await captureSnapshot(db, storage, services, { projectId, userId: user.sub, label: body.label ?? `Build ${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}` })).id;
    const buildId = await queueBuild(db, services, { projectId, snapshotId, userId: user.sub, profile: body.profile });
    await db.query("INSERT INTO activity_logs (project_id, actor_id, action, target_type, target_id, metadata, ip, user_agent) VALUES ($1, $2, 'build.queued', 'build', $3, $4, $5, $6)", [projectId, user.sub, buildId, JSON.stringify({ snapshotId, profile: body.profile }), request.ip, request.headers["user-agent"] ?? null]);
    await realtime.publish(projectId, "build.queued", { buildId, snapshotId, profile: body.profile }); reply.code(202); return { id: buildId, snapshotId, status: "queued", profile: body.profile, progress: 0 };
  });

  app.get("/projects/:projectId/builds/:id", async (request) => {
    const user = await requireUser(request); const { projectId, id } = idParamsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "project.read"); const result = await db.query<{ log_key?: string | null }>(`SELECT ${buildColumns}, b.log_key FROM build_jobs b JOIN snapshots s ON s.id = b.snapshot_id WHERE b.project_id = $1 AND b.id = $2`, [projectId, id]); const build = result.rows[0]; if (!build) throw new AppError(404, "BUILD_NOT_FOUND", "Buildが見つかりません。");
    let log = ""; if (build.log_key) log = (await services.objects.get(build.log_key)).toString("utf8"); return { ...build, log };
  });

  app.get("/projects/:projectId/builds/:id/artifact", async (request, reply) => {
    const user = await requireUser(request); const { projectId, id } = idParamsSchema.parse(request.params); await requireProjectPermission(db, user, projectId, "project.read"); const result = await db.query<{ artifact_key: string | null; status: string }>("SELECT artifact_key, status FROM build_jobs WHERE project_id = $1 AND id = $2", [projectId, id]); const build = result.rows[0];
    if (!build) throw new AppError(404, "BUILD_NOT_FOUND", "Buildが見つかりません。"); if (build.status !== "succeeded" || !build.artifact_key) throw new AppError(409, "ARTIFACT_NOT_READY", "成果物はまだ利用できません。");
    reply.type("application/zip").header("Content-Disposition", `attachment; filename=resource-pack-${id}.zip`).header("Cache-Control", "private, no-store").send(await services.objects.get(build.artifact_key));
  });
}
