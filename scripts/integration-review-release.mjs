import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import argon2 from "argon2";
import { zipSync } from "fflate";
import pg from "pg";
import { ObjectStore } from "@mona/build-core";

const { Pool } = pg;
const apiBase = process.env.API_BASE_URL ?? "http://127.0.0.1:4100/api/v1";
const databaseUrl = process.env.DATABASE_URL ?? "postgres://mona:mona_dev@localhost:5432/mona_resource_studio";
const reviewerUsername = process.env.INTEGRATION_REVIEWER_USERNAME ?? "phase6_reviewer";
const reviewerPassword = process.env.INTEGRATION_REVIEWER_PASSWORD ?? "reviewer-pass-123";
const adminUsername = process.env.SEED_ADMIN_USERNAME ?? "admin";
const adminPassword = process.env.SEED_ADMIN_PASSWORD ?? "change-me-now";
const objectStore = new ObjectStore({
  endpoint: process.env.MINIO_ENDPOINT ?? "http://localhost:9000",
  accessKey: process.env.MINIO_ACCESS_KEY ?? "test",
  secretKey: process.env.MINIO_SECRET_KEY ?? "testtest",
  bucket: process.env.MINIO_BUCKET ?? "mona-resource-studio",
});
const pool = new Pool({ connectionString: databaseUrl });

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function api(path, { token, method = "GET", json, body, expected = 200, binary = false } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers,
    body: json === undefined ? body : JSON.stringify(json),
  });
  const payload = binary
    ? Buffer.from(await response.arrayBuffer())
    : response.status === 204
      ? null
      : await response.json().catch(async () => ({ raw: await response.text() }));
  assert.equal(response.status, expected, `${method} ${path}: expected ${expected}, got ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function login(username, password) {
  const result = await api("/auth/login", { method: "POST", json: { username, password } });
  assert.ok(result.accessToken);
  return result.accessToken;
}

async function insertSucceededBuild({ projectId, snapshotId, requestedBy, artifact, label }) {
  const artifactHash = sha256(artifact);
  const created = await pool.query(
    `INSERT INTO build_jobs(project_id,snapshot_id,requested_by,status,profile,progress,artifact_key,artifact_sha256,artifact_size,started_at,finished_at)
     VALUES($1,$2,$3,'succeeded','release',100,'pending',$4,$5,now(),now()) RETURNING id`,
    [projectId, snapshotId, requestedBy, artifactHash, artifact.length],
  );
  const id = created.rows[0].id;
  const artifactKey = `builds/${projectId}/${id}/${label}.zip`;
  await objectStore.put(artifactKey, artifact, "application/zip");
  await pool.query("UPDATE build_jobs SET artifact_key=$2 WHERE id=$1", [id, artifactKey]);
  return id;
}

const createdObjects = [];
try {
  const readyResponse = await fetch(apiBase.replace(/\/api\/v1$/, "/ready"));
  assert.equal(readyResponse.status, 200, `API readiness check failed with HTTP ${readyResponse.status}`);
  const passwordHash = await argon2.hash(reviewerPassword, { type: argon2.argon2id });
  const reviewerRow = await pool.query(
    `INSERT INTO users(username,display_name,password_hash,system_role)
     VALUES($1,'Phase 6 Reviewer',$2,'user')
     ON CONFLICT(username) DO UPDATE SET password_hash=EXCLUDED.password_hash,disabled_at=NULL,updated_at=now()
     RETURNING id`,
    [reviewerUsername, passwordHash],
  );
  const reviewerId = reviewerRow.rows[0].id;

  const adminToken = await login(adminUsername, adminPassword);
  const reviewerToken = await login(reviewerUsername, reviewerPassword);
  const adminUser = await api("/auth/me", { token: adminToken });
  const suffix = new Date().toISOString().replaceAll(/[-:.TZ]/g, "");
  const project = await api("/projects", {
    token: adminToken,
    method: "POST",
    expected: 201,
    json: { name: `Phase 6 integration ${suffix}`, description: "Automated review/release integration test", minecraftVersion: "1.21.11" },
  });
  const projectId = project.id;
  await api(`/projects/${projectId}/members`, {
    token: adminToken,
    method: "PUT",
    json: { username: reviewerUsername, role: "manager" },
  });

  const pack = Buffer.from(zipSync({
    "pack.mcmeta": Buffer.from(JSON.stringify({ pack: { pack_format: 75, description: "Phase 6 integration" } })),
    "assets/minecraft/lang/en_us.json": Buffer.from(JSON.stringify({ "mona.phase6": "review-release" })),
  }));
  const form = new FormData();
  form.append("file", new Blob([pack], { type: "application/zip" }), "phase6-pack.zip");
  const imported = await api(`/projects/${projectId}/import`, { token: adminToken, method: "POST", body: form });
  assert.equal(imported.fileCount, 2);

  const snapshot1 = await api(`/projects/${projectId}/snapshots`, {
    token: adminToken,
    method: "POST",
    expected: 201,
    json: { label: "Phase 6 initial" },
  });
  const review = await api(`/projects/${projectId}/reviews`, {
    token: adminToken,
    method: "POST",
    expected: 201,
    json: { snapshotId: snapshot1.id, title: "Phase 6 review", description: "Integration verification" },
  });

  const selfApproval = await api(`/projects/${projectId}/reviews/${review.id}/decision`, {
    token: adminToken,
    method: "POST",
    expected: 409,
    json: { action: "approve", note: "must be rejected" },
  });
  assert.equal(selfApproval.error.code, "SELF_REVIEW_FORBIDDEN");
  const missingNote = await api(`/projects/${projectId}/reviews/${review.id}/decision`, {
    token: reviewerToken,
    method: "POST",
    expected: 400,
    json: { action: "request_changes", note: "" },
  });
  assert.equal(missingNote.error.code, "VALIDATION_ERROR");
  await api(`/projects/${projectId}/reviews/${review.id}/decision`, {
    token: reviewerToken,
    method: "POST",
    json: { action: "request_changes", note: "Please create the revised snapshot." },
  });

  const sameSnapshot = await api(`/projects/${projectId}/reviews/${review.id}/decision`, {
    token: adminToken,
    method: "POST",
    expected: 400,
    json: { action: "resubmit", snapshotId: snapshot1.id, note: "same snapshot must be rejected" },
  });
  assert.equal(sameSnapshot.error.code, "RESUBMIT_SNAPSHOT_INVALID");
  const snapshot2 = await api(`/projects/${projectId}/snapshots`, {
    token: adminToken,
    method: "POST",
    expected: 201,
    json: { label: "Phase 6 revised" },
  });
  await api(`/projects/${projectId}/reviews/${review.id}/decision`, {
    token: adminToken,
    method: "POST",
    json: { action: "resubmit", snapshotId: snapshot2.id, note: "Revised snapshot submitted." },
  });
  const approved = await api(`/projects/${projectId}/reviews/${review.id}/decision`, {
    token: reviewerToken,
    method: "POST",
    json: { action: "approve", note: "Approved by an independent reviewer." },
  });
  assert.equal(approved.status, "approved");

  const wrongBuildId = await insertSucceededBuild({ projectId, snapshotId: snapshot1.id, requestedBy: adminUser.id, artifact: pack, label: "wrong-snapshot" });
  const matchingBuildId = await insertSucceededBuild({ projectId, snapshotId: snapshot2.id, requestedBy: adminUser.id, artifact: pack, label: "approved-snapshot" });
  const objectRows = await pool.query("SELECT artifact_key FROM build_jobs WHERE id=ANY($1::uuid[])", [[wrongBuildId, matchingBuildId]]);
  createdObjects.push(...objectRows.rows.map((row) => row.artifact_key));

  const mismatch = await api(`/projects/${projectId}/releases`, {
    token: adminToken,
    method: "POST",
    expected: 409,
    json: { buildId: wrongBuildId, approvedReviewId: review.id, version: `mismatch-${suffix}`, releaseNotes: "must be rejected" },
  });
  assert.equal(mismatch.error.code, "RELEASE_NOT_ELIGIBLE");
  const release = await api(`/projects/${projectId}/releases`, {
    token: adminToken,
    method: "POST",
    expected: 201,
    json: { buildId: matchingBuildId, approvedReviewId: review.id, version: `phase6-${suffix}`, releaseNotes: "Integration release" },
  });
  const releaseObject = await pool.query("SELECT artifact_key FROM releases WHERE id=$1", [release.id]);
  createdObjects.push(releaseObject.rows[0].artifact_key);
  const downloaded = await api(`/projects/${projectId}/releases/${release.id}/artifact`, { token: adminToken, binary: true });
  assert.equal(sha256(downloaded), sha256(pack));
  const duplicate = await api(`/projects/${projectId}/releases`, {
    token: adminToken,
    method: "POST",
    expected: 409,
    json: { buildId: matchingBuildId, approvedReviewId: review.id, version: `phase6-${suffix}`, releaseNotes: "duplicate must be rejected" },
  });
  assert.equal(duplicate.error.code, "RELEASE_ALREADY_EXISTS");

  const audit = await pool.query("SELECT id,action FROM audit_logs WHERE project_id=$1 AND target_id=$2", [projectId, release.id]);
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].action, "release.published");
  let auditMutationBlocked = false;
  try {
    await pool.query("UPDATE audit_logs SET action=action WHERE id=$1", [audit.rows[0].id]);
  } catch (error) {
    auditMutationBlocked = String(error.message).includes("append-only");
  }
  assert.equal(auditMutationBlocked, true, "audit_logs UPDATE must be rejected by the database trigger");

  console.log(JSON.stringify({
    status: "passed",
    projectId,
    reviewerId,
    reviewId: review.id,
    approvedSnapshotId: snapshot2.id,
    releaseId: release.id,
    artifactSha256: release.artifactSha256,
    assertions: [
      "self approval rejected",
      "change-request note required",
      "same-snapshot resubmission rejected",
      "independent approval accepted",
      "mismatched build rejected",
      "release artifact hash verified",
      "duplicate release rejected",
      "audit log mutation rejected",
    ],
  }, null, 2));
} finally {
  await pool.end();
}
