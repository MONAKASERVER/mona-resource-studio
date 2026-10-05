import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { decodePackArchive, type SnapshotManifest } from "@mona/build-core";
import { requireUser } from "../auth.js";
import type { Database } from "../db/pool.js";
import { AppError } from "../errors.js";
import { requireProjectPermission } from "../policy.js";
import type { BuildServices } from "../services/builds.js";
import type { RealtimeHub } from "../services/realtime.js";
import { diffManifests, diffText, releaseEligibility } from "../services/reviews.js";

const projectParams = z.object({ projectId: z.string().uuid() });
const idParams = z.object({ projectId: z.string().uuid(), id: z.string().uuid() });
const reviewInput = z.object({ snapshotId: z.string().uuid(), baseSnapshotId: z.string().uuid().nullable().optional(), title: z.string().trim().min(1).max(160), description: z.string().trim().max(4000).default("") });
const decisionInput = z.object({ action: z.enum(["approve", "request_changes", "resubmit", "cancel"]), note: z.string().trim().max(4000).default(""), snapshotId: z.string().uuid().optional() }).superRefine((value, context) => { if (value.action === "request_changes" && !value.note) context.addIssue({ code: "custom", path: ["note"], message: "修正依頼にはコメントが必要です。" }); if (value.action === "resubmit" && !value.snapshotId) context.addIssue({ code: "custom", path: ["snapshotId"], message: "再申請するSnapshotが必要です。" }); });
const releaseInput = z.object({ buildId: z.string().uuid(), approvedReviewId: z.string().uuid(), version: z.string().trim().regex(/^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/, "Versionは英数字から始まる64文字以内で入力してください。"), releaseNotes: z.string().trim().max(10_000).default("") });
const reviewColumns = `r.id,r.snapshot_id AS "snapshotId",r.base_snapshot_id AS "baseSnapshotId",r.requested_by AS "requestedBy",u.display_name AS "requestedByName",r.title,r.description,r.status,r.created_at AS "createdAt",r.decided_at AS "decidedAt",s.label AS "snapshotLabel",bs.label AS "baseSnapshotLabel"`;

function pgCode(error: unknown): string | undefined { return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined; }

export async function reviewRoutes(app: FastifyInstance, db: Database, builds: BuildServices, hub: RealtimeHub): Promise<void> {
  app.get("/projects/:projectId/reviews", async (request) => {
    const user = await requireUser(request); const { projectId } = projectParams.parse(request.params); await requireProjectPermission(db, user, projectId, "project.read");
    return (await db.query(`SELECT ${reviewColumns} FROM review_requests r JOIN users u ON u.id=r.requested_by JOIN snapshots s ON s.id=r.snapshot_id LEFT JOIN snapshots bs ON bs.id=r.base_snapshot_id WHERE r.project_id=$1 ORDER BY r.created_at DESC LIMIT 200`, [projectId])).rows;
  });

  app.post("/projects/:projectId/reviews", async (request, reply) => {
    const user = await requireUser(request); const { projectId } = projectParams.parse(request.params); await requireProjectPermission(db, user, projectId, "review.request"); const body = reviewInput.parse(request.body); const client = await db.connect(); let id = "";
    try {
      await client.query("BEGIN"); const snapshot = await client.query<{ created_at: string }>("SELECT created_at FROM snapshots WHERE id=$1 AND project_id=$2 FOR SHARE", [body.snapshotId, projectId]); if (!snapshot.rows[0]) throw new AppError(404, "SNAPSHOT_NOT_FOUND", "Snapshotが見つかりません。");
      let baseSnapshotId = body.baseSnapshotId ?? null;
      if (baseSnapshotId) { const base = await client.query("SELECT 1 FROM snapshots WHERE id=$1 AND project_id=$2 AND id<>$3", [baseSnapshotId, projectId, body.snapshotId]); if (!base.rowCount) throw new AppError(400, "BASE_SNAPSHOT_INVALID", "比較元Snapshotが不正です。"); }
      else baseSnapshotId = (await client.query<{ id: string }>("SELECT id FROM snapshots WHERE project_id=$1 AND created_at<$2 AND id<>$3 ORDER BY created_at DESC LIMIT 1", [projectId, snapshot.rows[0].created_at, body.snapshotId])).rows[0]?.id ?? null;
      const open = await client.query("SELECT 1 FROM review_requests WHERE project_id=$1 AND snapshot_id=$2 AND status='open'", [projectId, body.snapshotId]); if (open.rowCount) throw new AppError(409, "REVIEW_ALREADY_OPEN", "このSnapshotには進行中のReviewがあります。");
      const created = await client.query<{ id: string }>("INSERT INTO review_requests(project_id,snapshot_id,base_snapshot_id,requested_by,title,description,status) VALUES($1,$2,$3,$4,$5,$6,'open') RETURNING id", [projectId, body.snapshotId, baseSnapshotId, user.sub, body.title, body.description]); id = created.rows[0]!.id;
      await client.query("INSERT INTO review_events(review_id,actor_id,action,note) VALUES($1,$2,'submitted',$3)", [id, user.sub, body.description]);
      await client.query(`INSERT INTO notifications(user_id,project_id,type,title,body,metadata) SELECT pm.user_id,$1,'review.requested','レビュー申請',$2,$3 FROM project_members pm WHERE pm.project_id=$1 AND pm.user_id<>$4 AND pm.role IN ('owner','admin','manager')`, [projectId, body.title, JSON.stringify({ reviewId: id, snapshotId: body.snapshotId }), user.sub]);
      await client.query("INSERT INTO activity_logs(project_id,actor_id,action,target_type,target_id,metadata,ip,user_agent) VALUES($1,$2,'review.submitted','review',$3,$4,$5,$6)", [projectId, user.sub, id, JSON.stringify({ snapshotId: body.snapshotId, baseSnapshotId }), request.ip, request.headers["user-agent"] ?? null]); await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    await hub.publish(projectId, "review.changed", { reviewId: id, status: "open" }); reply.code(201); return { id, status: "open" };
  });

  app.get("/projects/:projectId/reviews/:id", async (request) => {
    const user = await requireUser(request); const { projectId, id } = idParams.parse(request.params); await requireProjectPermission(db, user, projectId, "project.read");
    const result = await db.query<{ snapshotId: string; baseSnapshotId: string | null; manifest: SnapshotManifest; base_manifest: SnapshotManifest | null }>(`SELECT ${reviewColumns},s.manifest,bs.manifest AS base_manifest FROM review_requests r JOIN users u ON u.id=r.requested_by JOIN snapshots s ON s.id=r.snapshot_id LEFT JOIN snapshots bs ON bs.id=r.base_snapshot_id WHERE r.project_id=$1 AND r.id=$2`, [projectId, id]); const review = result.rows[0]; if (!review) throw new AppError(404, "REVIEW_NOT_FOUND", "Reviewが見つかりません。");
    const events = (await db.query(`SELECT e.id,e.action,e.note,e.created_at AS "createdAt",u.id AS "actorId",u.display_name AS "actorName" FROM review_events e JOIN users u ON u.id=e.actor_id WHERE e.review_id=$1 ORDER BY e.created_at`, [id])).rows;
    const diff = diffManifests(review.base_manifest, review.manifest); return { ...review, manifest: undefined, base_manifest: undefined, events, diff, summary: Object.fromEntries(["added", "removed", "modified", "unchanged"].map((status) => [status, diff.filter((entry) => entry.status === status).length])) };
  });

  app.get("/projects/:projectId/reviews/:id/text-diff", async (request) => {
    const user = await requireUser(request); const { projectId, id } = idParams.parse(request.params); await requireProjectPermission(db, user, projectId, "project.read"); const { path } = z.object({ path: z.string().min(1).max(1024) }).parse(request.query);
    const result = await db.query<{ artifact_key: string | null; base_artifact_key: string | null; manifest: SnapshotManifest; base_manifest: SnapshotManifest | null }>(`SELECT s.artifact_key,bs.artifact_key AS base_artifact_key,s.manifest,bs.manifest AS base_manifest FROM review_requests r JOIN snapshots s ON s.id=r.snapshot_id LEFT JOIN snapshots bs ON bs.id=r.base_snapshot_id WHERE r.id=$1 AND r.project_id=$2`, [id, projectId]); const row = result.rows[0]; if (!row?.artifact_key) throw new AppError(404, "REVIEW_NOT_FOUND", "Reviewが見つかりません。");
    const currentMeta = row.manifest.files.find((file) => file.path === path); const baseMeta = row.base_manifest?.files.find((file) => file.path === path); if (!currentMeta && !baseMeta) throw new AppError(404, "DIFF_PATH_NOT_FOUND", "Snapshot内に対象ファイルがありません。");
    if ((currentMeta?.size ?? 0) > 512 * 1024 || (baseMeta?.size ?? 0) > 512 * 1024) throw new AppError(413, "DIFF_FILE_TOO_LARGE", "テキスト差分は512KiB以下のファイルに対応しています。");
    const allowed = ["application/json", "text/plain", "text/markdown", null]; if (!allowed.includes(currentMeta?.mimeType ?? baseMeta?.mimeType ?? null)) throw new AppError(415, "DIFF_BINARY", "バイナリファイルのテキスト差分は表示できません。");
    const current = decodePackArchive(await builds.objects.get(row.artifact_key)).get(path)?.toString("utf8") ?? ""; const base = row.base_artifact_key ? decodePackArchive(await builds.objects.get(row.base_artifact_key)).get(path)?.toString("utf8") ?? "" : ""; return diffText(base, current);
  });

  app.post("/projects/:projectId/reviews/:id/decision", async (request) => {
    const user = await requireUser(request); const { projectId, id } = idParams.parse(request.params); const body = decisionInput.parse(request.body); const role = await requireProjectPermission(db, user, projectId, body.action === "resubmit" || body.action === "cancel" ? "review.request" : "review.decide"); const client = await db.connect(); let nextStatus = ""; let requester = "";
    try {
      await client.query("BEGIN"); const found = await client.query<{ status: string; requested_by: string; title: string; snapshot_id: string }>("SELECT status,requested_by,title,snapshot_id FROM review_requests WHERE id=$1 AND project_id=$2 FOR UPDATE", [id, projectId]); const review = found.rows[0]; if (!review) throw new AppError(404, "REVIEW_NOT_FOUND", "Reviewが見つかりません。"); requester = review.requested_by;
      if (body.action === "approve" || body.action === "request_changes") { if (review.status !== "open") throw new AppError(409, "REVIEW_STATE_INVALID", "進行中のReviewだけを判定できます。"); if (review.requested_by === user.sub) throw new AppError(409, "SELF_REVIEW_FORBIDDEN", "申請者自身は承認・修正依頼できません。"); nextStatus = body.action === "approve" ? "approved" : "changes_requested"; }
      else if (body.action === "resubmit") { if (review.status !== "changes_requested" || review.requested_by !== user.sub) throw new AppError(409, "REVIEW_STATE_INVALID", "申請者だけが修正依頼済みReviewを再申請できます。"); const snapshot = await client.query("SELECT 1 FROM snapshots WHERE id=$1 AND project_id=$2", [body.snapshotId, projectId]); if (!snapshot.rowCount || body.snapshotId === review.snapshot_id) throw new AppError(400, "RESUBMIT_SNAPSHOT_INVALID", "修正後に作成した別のSnapshotを選択してください。"); const duplicate = await client.query("SELECT 1 FROM review_requests WHERE project_id=$1 AND snapshot_id=$2 AND status='open' AND id<>$3", [projectId, body.snapshotId, id]); if (duplicate.rowCount) throw new AppError(409, "REVIEW_ALREADY_OPEN", "選択したSnapshotには進行中のReviewがあります。"); await client.query("UPDATE review_requests SET base_snapshot_id=snapshot_id,snapshot_id=$3 WHERE id=$1 AND project_id=$2", [id, projectId, body.snapshotId]); nextStatus = "open"; }
      else { if (!(["owner", "admin", "manager"].includes(role)) && review.requested_by !== user.sub) throw new AppError(403, "REVIEW_CANCEL_FORBIDDEN", "このReviewを取り消せません。"); if (!["open", "changes_requested"].includes(review.status)) throw new AppError(409, "REVIEW_STATE_INVALID", "このReviewは取り消せません。"); nextStatus = "cancelled"; }
      await client.query("UPDATE review_requests SET status=$3::review_status,decided_at=CASE WHEN $3::review_status='open'::review_status THEN NULL ELSE now() END WHERE id=$1 AND project_id=$2", [id, projectId, nextStatus]); await client.query("INSERT INTO review_events(review_id,actor_id,action,note) VALUES($1,$2,$3,$4)", [id, user.sub, body.action, body.note]);
      if (requester !== user.sub) await client.query("INSERT INTO notifications(user_id,project_id,type,title,body,metadata) VALUES($1,$2,'review.decided',$3,$4,$5)", [requester, projectId, `Review: ${nextStatus}`, body.note, JSON.stringify({ reviewId: id, status: nextStatus })]);
      const metadata = JSON.stringify({ status: nextStatus, note: body.note, snapshotId: body.snapshotId }); await client.query("INSERT INTO activity_logs(project_id,actor_id,action,target_type,target_id,metadata,ip,user_agent) VALUES($1,$2,$3,'review',$4,$5,$6,$7)", [projectId, user.sub, `review.${body.action}`, id, metadata, request.ip, request.headers["user-agent"] ?? null]); await client.query("INSERT INTO audit_logs(project_id,actor_id,action,target_type,target_id,metadata,ip) VALUES($1,$2,$3,'review',$4,$5,$6)", [projectId, user.sub, `review.${body.action}`, id, metadata, request.ip]); await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    await hub.publish(projectId, "review.changed", { reviewId: id, status: nextStatus }); return { id, status: nextStatus };
  });

  app.get("/projects/:projectId/releases", async (request) => {
    const user = await requireUser(request); const { projectId } = projectParams.parse(request.params); await requireProjectPermission(db, user, projectId, "project.read"); return (await db.query(`SELECT r.id,r.build_id AS "buildId",r.approved_review_id AS "approvedReviewId",r.version,r.release_notes AS "releaseNotes",r.artifact_sha256 AS "artifactSha256",r.artifact_size::text AS "artifactSize",r.published_at AS "publishedAt",u.display_name AS "publishedBy" FROM releases r JOIN users u ON u.id=r.published_by WHERE r.project_id=$1 ORDER BY r.published_at DESC`, [projectId])).rows;
  });

  app.post("/projects/:projectId/releases", async (request, reply) => {
    const user = await requireUser(request); const { projectId } = projectParams.parse(request.params); await requireProjectPermission(db, user, projectId, "release.publish"); const body = releaseInput.parse(request.body);
    const result = await db.query<{ build_status: string; build_profile: string; build_snapshot_id: string; artifact_key: string | null; artifact_sha256: string | null; artifact_size: string | null; review_status: string; review_snapshot_id: string }>(`SELECT b.status AS build_status,b.profile AS build_profile,b.snapshot_id AS build_snapshot_id,b.artifact_key,b.artifact_sha256,b.artifact_size::text,r.status AS review_status,r.snapshot_id AS review_snapshot_id FROM build_jobs b JOIN review_requests r ON r.id=$3 AND r.project_id=b.project_id WHERE b.id=$1 AND b.project_id=$2`, [body.buildId, projectId, body.approvedReviewId]); const candidate = result.rows[0]; if (!candidate) throw new AppError(404, "RELEASE_SOURCE_NOT_FOUND", "BuildまたはReviewが見つかりません。"); const errors = releaseEligibility({ buildStatus: candidate.build_status, buildProfile: candidate.build_profile, buildSnapshotId: candidate.build_snapshot_id, artifactKey: candidate.artifact_key, reviewStatus: candidate.review_status, reviewSnapshotId: candidate.review_snapshot_id }); if (errors.length) throw new AppError(409, "RELEASE_NOT_ELIGIBLE", "承認済みSnapshotの成功したRelease Buildだけを公開できます。", errors);
    const artifact = await builds.objects.get(candidate.artifact_key!); const sha256 = createHash("sha256").update(artifact).digest("hex"); if (sha256 !== candidate.artifact_sha256 || artifact.length !== Number(candidate.artifact_size)) throw new AppError(409, "ARTIFACT_CORRUPT", "Build成果物の整合性検証に失敗しました。");
    const id = randomUUID(); const artifactKey = `releases/${projectId}/${id}.zip`; await builds.objects.put(artifactKey, artifact, "application/zip"); const client = await db.connect();
    try {
      await client.query("BEGIN"); await client.query("INSERT INTO releases(id,project_id,build_id,approved_review_id,version,release_notes,artifact_key,artifact_sha256,artifact_size,published_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [id, projectId, body.buildId, body.approvedReviewId, body.version, body.releaseNotes, artifactKey, sha256, artifact.length, user.sub]);
      await client.query("INSERT INTO activity_logs(project_id,actor_id,action,target_type,target_id,metadata,ip,user_agent) VALUES($1,$2,'release.published','release',$3,$4,$5,$6)", [projectId, user.sub, id, JSON.stringify({ version: body.version, buildId: body.buildId, reviewId: body.approvedReviewId, sha256, size: artifact.length }), request.ip, request.headers["user-agent"] ?? null]);
      await client.query("INSERT INTO audit_logs(project_id,actor_id,action,target_type,target_id,metadata,ip) VALUES($1,$2,'release.published','release',$3,$4,$5)", [projectId, user.sub, id, JSON.stringify({ version: body.version, buildId: body.buildId, reviewId: body.approvedReviewId, sha256, size: artifact.length }), request.ip]);
      await client.query(`INSERT INTO notifications(user_id,project_id,type,title,body,metadata) SELECT pm.user_id,$1,'release.published','Release公開',$2,$3 FROM project_members pm WHERE pm.project_id=$1 AND pm.user_id<>$4`, [projectId, body.version, JSON.stringify({ releaseId: id, version: body.version }), user.sub]); await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); await builds.objects.remove(artifactKey).catch(() => undefined); if (pgCode(error) === "23505") throw new AppError(409, "RELEASE_ALREADY_EXISTS", "同じVersionまたはBuildのReleaseが既に存在します。"); throw error; } finally { client.release(); }
    await hub.publish(projectId, "release.published", { releaseId: id, version: body.version }); reply.code(201); return { id, version: body.version, artifactSha256: sha256, artifactSize: String(artifact.length) };
  });

  app.get("/projects/:projectId/releases/:id/artifact", async (request, reply) => {
    const user = await requireUser(request); const { projectId, id } = idParams.parse(request.params); await requireProjectPermission(db, user, projectId, "project.read"); const result = await db.query<{ artifact_key: string | null; artifact_sha256: string | null; version: string }>("SELECT artifact_key,artifact_sha256,version FROM releases WHERE id=$1 AND project_id=$2", [id, projectId]); const release = result.rows[0]; if (!release?.artifact_key) throw new AppError(404, "RELEASE_NOT_FOUND", "Releaseが見つかりません。"); const artifact = await builds.objects.get(release.artifact_key); const sha256 = createHash("sha256").update(artifact).digest("hex"); if (sha256 !== release.artifact_sha256) throw new AppError(409, "RELEASE_CORRUPT", "Release成果物の整合性検証に失敗しました。"); reply.type("application/zip").header("Content-Disposition", `attachment; filename=monaka-resource-${release.version}.zip`).header("ETag", `\"${sha256}\"`).header("Cache-Control", "private, no-store").send(artifact);
  });
}
