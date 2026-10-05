import { readFile } from "node:fs/promises";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { BUILD_QUEUE_NAME, encodePackArchive, ObjectStore, sha256, type BuildJobPayload, type BuildProfile, type SnapshotManifest } from "@mona/build-core";
import type { Database } from "../db/pool.js";
import { AppError } from "../errors.js";
import { ProjectStorage } from "./storage.js";

export class BuildServices {
  readonly objects: ObjectStore;
  private redis: Redis | null = null;
  private queue: Queue<BuildJobPayload> | null = null;
  constructor(private readonly redisUrl: string, objectConfig: ConstructorParameters<typeof ObjectStore>[0]) { this.objects = new ObjectStore(objectConfig); }
  async enqueue(payload: BuildJobPayload): Promise<void> {
    this.redis ??= new Redis(this.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: true });
    this.queue ??= new Queue<BuildJobPayload>(BUILD_QUEUE_NAME, { connection: this.redis });
    await this.queue.add("build", payload, { jobId: payload.buildId, attempts: 1, removeOnComplete: 200, removeOnFail: 500 });
  }
  async close(): Promise<void> { await this.queue?.close(); if (this.redis) await this.redis.quit().catch(() => this.redis?.disconnect()); }
}

interface SnapshotRow { path: string; size_bytes: string; sha256: string; mime_type: string | null; current_version: number; }

export async function captureSnapshot(db: Database, storage: ProjectStorage, services: BuildServices, input: { projectId: string; userId: string; label: string }): Promise<{ id: string; label: string; manifest: SnapshotManifest; createdAt: string }> {
  const client = await db.connect(); let rows: SnapshotRow[] = []; let minecraftVersion = ""; const files = new Map<string, Buffer>();
  try {
    await client.query("BEGIN"); await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.projectId]);
    const project = await client.query<{ minecraft_version: string }>("SELECT minecraft_version FROM projects WHERE id = $1 AND archived_at IS NULL", [input.projectId]); if (!project.rows[0]) throw new AppError(404, "PROJECT_NOT_FOUND", "プロジェクトが見つかりません。"); minecraftVersion = project.rows[0].minecraft_version;
    rows = (await client.query<SnapshotRow>("SELECT path, size_bytes, sha256, mime_type, current_version FROM project_files WHERE project_id = $1 ORDER BY path", [input.projectId])).rows; if (rows.length === 0) throw new AppError(409, "PACK_EMPTY", "空のResource PackはSnapshot化できません。");
    for (const row of rows) { const bytes = await readFile(storage.resolveProjectFile(input.projectId, row.path)); if (bytes.length !== Number(row.size_bytes) || sha256(bytes) !== row.sha256) throw new AppError(409, "SNAPSHOT_SOURCE_CHANGED", `編集中にファイルが変更されました: ${row.path}`); files.set(row.path, bytes); }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  const createdAt = new Date().toISOString(); const manifest: SnapshotManifest = { schemaVersion: 1, projectId: input.projectId, minecraftVersion, createdAt, files: rows.map((row) => ({ path: row.path, size: Number(row.size_bytes), sha256: row.sha256, mimeType: row.mime_type, version: row.current_version })) };
  const archive = encodePackArchive(files); const idResult = await db.query<{ id: string }>("SELECT gen_random_uuid() AS id"); const id = idResult.rows[0]!.id; const artifactKey = `snapshots/${input.projectId}/${id}.zip`;
  await services.objects.put(artifactKey, archive, "application/zip");
  try { await db.query("INSERT INTO snapshots (id, project_id, label, manifest, artifact_key, created_by, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)", [id, input.projectId, input.label, JSON.stringify(manifest), artifactKey, input.userId, createdAt]); }
  catch (error) { await services.objects.remove(artifactKey).catch(() => undefined); throw error; }
  return { id, label: input.label, manifest, createdAt };
}

export async function queueBuild(db: Database, services: BuildServices, input: { projectId: string; snapshotId: string; userId: string; profile: BuildProfile }): Promise<string> {
  const created = await db.query<{ id: string }>("INSERT INTO build_jobs (project_id, snapshot_id, requested_by, profile) VALUES ($1, $2, $3, $4) RETURNING id", [input.projectId, input.snapshotId, input.userId, input.profile]); const buildId = created.rows[0]!.id;
  try { await services.enqueue({ buildId, projectId: input.projectId, snapshotId: input.snapshotId, profile: input.profile }); }
  catch (error) { await db.query("UPDATE build_jobs SET status = 'failed', error_code = 'QUEUE_UNAVAILABLE', finished_at = now() WHERE id = $1", [buildId]); throw new AppError(503, "QUEUE_UNAVAILABLE", "Build Queueへ接続できません。RedisとWorkerを確認してください。", error instanceof Error ? error.message : String(error)); }
  return buildId;
}
