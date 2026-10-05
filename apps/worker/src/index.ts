import "dotenv/config";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import pg from "pg";
import { BUILD_QUEUE_NAME, decodePackArchive, materializePack, ObjectStore, sha256, type BuildJobPayload, type SnapshotManifest } from "@mona/build-core";
import { runPackSquash } from "./runner.js";

const required = (name: string, fallback?: string): string => { const value = process.env[name] ?? fallback; if (!value) throw new Error(`${name} is required`); return value; };
const databaseUrl = required("DATABASE_URL", "postgres://mona:mona_dev@localhost:5432/mona_resource_studio");
const redisUrl = required("REDIS_URL", "redis://localhost:6379"); const binary = required("PACKSQUASH_BINARY", "packsquash");
const objects = new ObjectStore({ endpoint: required("MINIO_ENDPOINT", "http://localhost:9000"), accessKey: required("MINIO_ACCESS_KEY", "test"), secretKey: required("MINIO_SECRET_KEY", "testtest"), bucket: required("MINIO_BUCKET", "mona-resource-studio") });
const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 }); const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const publish = async (projectId: string, type: string, payload: Record<string, unknown>) => redis.publish("mona-resource-studio:events", JSON.stringify({ type, projectId, at: new Date().toISOString(), payload })).catch(() => 0);

const worker = new Worker<BuildJobPayload>(BUILD_QUEUE_NAME, async (job: Job<BuildJobPayload>) => {
  const { buildId, projectId, snapshotId, profile } = job.data; const log: string[] = []; let logBytes = 0;
  const append = (line: string) => { const entry = `[${new Date().toISOString()}] ${line}`; if (logBytes + Buffer.byteLength(entry) < 2_000_000) { log.push(entry); logBytes += Buffer.byteLength(entry); } };
  const progress = async (value: number, message: string) => { append(message); await job.updateProgress(value); await pool.query("UPDATE build_jobs SET progress = $2 WHERE id = $1", [buildId, value]); await publish(projectId, "build.progress", { buildId, progress: value }); };
  const workRoot = await mkdtemp(join(tmpdir(), `mona-build-${buildId}-`)); const logKey = `logs/${projectId}/${buildId}.log`;
  try {
    const claimed = await pool.query("UPDATE build_jobs SET status = 'running', started_at = now(), progress = 5, error_code = NULL WHERE id = $1 AND status = 'queued' RETURNING id", [buildId]); if (!claimed.rowCount) { append("Job is no longer queued; skipped."); return; }
    await progress(10, `Snapshot ${snapshotId} を取得しています。`);
    const snapshotResult = await pool.query<{ artifact_key: string | null; manifest: SnapshotManifest }>("SELECT artifact_key, manifest FROM snapshots WHERE id = $1 AND project_id = $2", [snapshotId, projectId]); const snapshot = snapshotResult.rows[0]; if (!snapshot?.artifact_key) throw new Error("SNAPSHOT_NOT_FOUND");
    const archive = await objects.get(snapshot.artifact_key); const files = decodePackArchive(archive);
    for (const record of snapshot.manifest.files) { const bytes = files.get(record.path); if (!bytes || bytes.length !== record.size || sha256(bytes) !== record.sha256) throw new Error(`SNAPSHOT_CORRUPT:${record.path}`); }
    if (files.size !== snapshot.manifest.files.length) throw new Error("SNAPSHOT_CORRUPT:unexpected-file");
    await progress(25, `${files.size} files のSnapshot整合性を確認しました。`);
    const packRoot = join(workRoot, "pack"); await materializePack(files, packRoot);
    const metadata = files.get("pack.mcmeta"); if (!metadata) throw new Error("PACK_META_MISSING"); try { JSON.parse(metadata.toString("utf8")); } catch { throw new Error("PACK_META_INVALID"); }
    for (const [path, bytes] of files) if ((path.endsWith(".json") || path.endsWith(".mcmeta")) && bytes.length < 10 * 1024 * 1024) try { JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`JSON_INVALID:${path}`); }
    await progress(40, "Preflight validationが完了しました。");
    const outputFile = join(workRoot, "resource-pack.zip"); append(`PackSquash profile=${profile}`);
    const artifact = await runPackSquash({ binary, workRoot, packRoot, outputFile, profile, timeoutMs: profile === "release" ? 10 * 60_000 : 2 * 60_000, onLog: append });
    await progress(90, `PackSquashが${artifact.length.toLocaleString()} bytesの成果物を生成しました。`);
    const artifactKey = `artifacts/${projectId}/${buildId}.zip`; await objects.put(artifactKey, artifact, "application/zip"); await objects.put(logKey, Buffer.from(`${log.join("\n")}\n`), "text/plain; charset=utf-8");
    await pool.query("UPDATE build_jobs SET status = 'succeeded', progress = 100, log_key = $2, artifact_key = $3, artifact_sha256 = $4, artifact_size = $5, finished_at = now() WHERE id = $1", [buildId, logKey, artifactKey, sha256(artifact), artifact.length]);
    await publish(projectId, "build.succeeded", { buildId, progress: 100 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error); append(`FAILED: ${message}`); await objects.put(logKey, Buffer.from(`${log.join("\n")}\n`), "text/plain; charset=utf-8").catch(() => undefined);
    await pool.query("UPDATE build_jobs SET status = 'failed', log_key = $2, error_code = $3, finished_at = now() WHERE id = $1", [buildId, logKey, message.slice(0, 160)]).catch(() => undefined); await publish(projectId, "build.failed", { buildId, error: message.slice(0, 160) }); throw error;
  } finally { await rm(workRoot, { recursive: true, force: true }); }
}, { connection: redis, concurrency: Number(process.env.BUILD_CONCURRENCY ?? 2), lockDuration: 15 * 60_000 });

worker.on("ready", () => console.log(`Mona Resource Studio worker is consuming ${BUILD_QUEUE_NAME}.`)); worker.on("failed", (job, error) => console.error({ buildId: job?.data.buildId, error }, "Build failed")); worker.on("error", (error) => console.error(error));
const shutdown = async () => { await worker.close(); await pool.end(); await redis.quit(); };
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0))); process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
