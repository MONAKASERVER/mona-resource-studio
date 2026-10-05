import type { ImportReport, ProjectFile, ProjectSummary, SessionUser } from "@mona/shared";
import type { CitRule } from "@mona/cit-core";
import type { StudioProblem } from "@mona/shared";

export interface SessionResponse { accessToken: string; refreshToken: string; expiresIn: number; user: SessionUser; }
interface TokenResponse { accessToken: string; refreshToken: string; expiresIn: number; }
export interface ItemCategory { id: string; parentId: string | null; name: string; sortOrder: number; }
export interface LogicalItem { id: string; logicalId: string; displayName: string; baseItemId: string; categoryId: string | null; categoryName?: string | null; textureRef: string | null; modelRef: string | null; updatedAt: string; }
export interface CitWorkspace { provider: string; namespace: string; minecraftVersion: string; rules: CitRule[]; problems: StudioProblem[]; baseVersions: Record<string, number>; rawFiles: Array<{ path: string; version: number; json: string }>; }
export interface SnapshotRecord { id: string; label: string; manifest: { files: Array<{ path: string; size: number; sha256: string }> }; createdAt: string; createdBy: string; }
export interface BuildRecord { id: string; snapshotId: string; snapshotLabel: string; status: "queued" | "running" | "succeeded" | "failed" | "cancelled"; profile: "development" | "release"; progress: number; artifactSha256: string | null; artifactSize: string | null; errorCode: string | null; createdAt: string; startedAt: string | null; finishedAt: string | null; log?: string; }
export interface PresenceUser { id: string; username: string; displayName: string; connectedAt: string; }
export interface FileLock { fileId: string; path: string; ownerId: string; username: string; displayName: string; createdAt: string; expiresAt: string; }
export interface ProjectMember { id: string; username: string; displayName: string; role: "owner" | "admin" | "manager" | "editor" | "viewer"; joinedAt: string; }
export interface ProjectComment { id: string; body: string; anchor: Record<string, unknown> | null; fileId: string | null; filePath: string | null; logicalItemId: string | null; logicalItemName: string | null; authorId: string; username: string; displayName: string; resolvedAt: string | null; createdAt: string; }
export interface ActivityEntry { id: string; action: string; targetType: string; targetId: string | null; metadata: Record<string, unknown>; createdAt: string; username: string | null; displayName: string | null; }
export interface StudioNotification { id: string; projectId: string | null; projectName: string | null; type: string; title: string; body: string; metadata: Record<string, unknown>; readAt: string | null; createdAt: string; }
export interface RealtimeEvent { type: string; projectId: string; at: string; payload: Record<string, unknown>; }
export type ReviewStatus = "open" | "approved" | "changes_requested" | "cancelled";
export interface ReviewRecord { id: string; snapshotId: string; baseSnapshotId: string | null; requestedBy: string; requestedByName: string; title: string; description: string; status: ReviewStatus; createdAt: string; decidedAt: string | null; snapshotLabel: string; baseSnapshotLabel: string | null; }
export interface ReviewDetail extends ReviewRecord { events: Array<{ id: string; action: string; note: string; createdAt: string; actorId: string; actorName: string }>; diff: Array<{ path: string; status: "added" | "removed" | "modified" | "unchanged"; before: { sha256: string; size: number; version: number } | null; after: { sha256: string; size: number; version: number } | null }>; summary: Record<"added" | "removed" | "modified" | "unchanged", number>; }
export interface ReleaseRecord { id: string; buildId: string; approvedReviewId: string; version: string; releaseNotes: string; artifactSha256: string; artifactSize: string; publishedAt: string; publishedBy: string; }
export interface ReviewTextDiff { lines: Array<{ kind: "context" | "add" | "remove"; text: string; beforeLine: number | null; afterLine: number | null }>; truncated: boolean; }

export function realtimeWebSocketUrl(baseUrl: string, projectId: string, ticket: string): URL {
  const url = new URL(baseUrl); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const basePath = url.pathname.replace(/\/$/, ""); url.pathname = `${basePath}/api/v1/projects/${projectId}/realtime`;
  url.search = new URLSearchParams({ ticket }).toString(); return url;
}

export class ApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number, public readonly details?: unknown) { super(message); }
}

export class StudioApi {
  private refreshToken = "";
  private refreshRequest: Promise<void> | null = null;
  constructor(public baseUrl: string, private accessToken = "", private readonly onTokens?: (accessToken: string, refreshToken: string) => void) {}
  setTokens(accessToken: string, refreshToken: string): void { this.accessToken = accessToken; this.refreshToken = refreshToken; }

  private async refresh(): Promise<void> {
    if (!this.refreshToken) throw new ApiError("AUTH_REQUIRED", "再ログインが必要です。", 401);
    const response = await fetch(`${this.baseUrl}/api/v1/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: this.refreshToken }),
    });
    if (!response.ok) throw new ApiError("REFRESH_INVALID", "セッションの有効期限が切れました。再ログインしてください。", 401);
    const tokens = await response.json() as TokenResponse;
    this.accessToken = tokens.accessToken;
    this.refreshToken = tokens.refreshToken;
    this.onTokens?.(tokens.accessToken, tokens.refreshToken);
  }

  private async request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
    const hasBody = init.body !== undefined && init.body !== null;
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { ...(hasBody && !(init.body instanceof FormData) ? { "Content-Type": "application/json" } : {}), ...(this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : {}), ...init.headers },
    });
    if (response.status === 401 && retry && this.refreshToken && !["/api/v1/auth/login", "/api/v1/auth/refresh", "/api/v1/auth/logout"].includes(path)) {
      this.refreshRequest ??= this.refresh().finally(() => { this.refreshRequest = null; });
      await this.refreshRequest;
      return this.request<T>(path, init, false);
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: { code: "HTTP_ERROR", message: `HTTP ${response.status}` } })) as { error?: { code?: string; message?: string; details?: unknown } };
      throw new ApiError(payload.error?.code ?? "HTTP_ERROR", payload.error?.message ?? `HTTP ${response.status}`, response.status, payload.error?.details);
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }

  login(username: string, password: string): Promise<SessionResponse> { return this.request("/api/v1/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }); }
  logout(): Promise<void> { return this.request("/api/v1/auth/logout", { method: "POST", body: JSON.stringify({ refreshToken: this.refreshToken }) }, false); }
  listProjects(): Promise<ProjectSummary[]> { return this.request("/api/v1/projects"); }
  createProject(input: { name: string; description: string; minecraftVersion: string }): Promise<ProjectSummary> { return this.request("/api/v1/projects", { method: "POST", body: JSON.stringify(input) }); }
  listCategories(projectId: string): Promise<ItemCategory[]> { return this.request(`/api/v1/projects/${projectId}/categories`); }
  createCategory(projectId: string, name: string, parentId: string | null = null): Promise<ItemCategory> { return this.request(`/api/v1/projects/${projectId}/categories`, { method: "POST", body: JSON.stringify({ name, parentId }) }); }
  deleteCategory(projectId: string, categoryId: string): Promise<void> { return this.request(`/api/v1/projects/${projectId}/categories/${categoryId}`, { method: "DELETE" }); }
  listItems(projectId: string): Promise<LogicalItem[]> { return this.request(`/api/v1/projects/${projectId}/items`); }
  createItem(projectId: string, input: { logicalId: string; displayName: string; baseItemId: string; categoryId: string | null; textureRef: string | null; modelRef: string | null }): Promise<LogicalItem> { return this.request(`/api/v1/projects/${projectId}/items`, { method: "POST", body: JSON.stringify(input) }); }
  updateItem(projectId: string, itemId: string, input: { logicalId: string; displayName: string; baseItemId: string; categoryId: string | null; textureRef: string | null; modelRef: string | null }): Promise<LogicalItem> { return this.request(`/api/v1/projects/${projectId}/items/${itemId}`, { method: "PATCH", body: JSON.stringify(input) }); }
  deleteItem(projectId: string, itemId: string): Promise<void> { return this.request(`/api/v1/projects/${projectId}/items/${itemId}`, { method: "DELETE" }); }
  listCit(projectId: string): Promise<CitWorkspace> { return this.request(`/api/v1/projects/${projectId}/cit`); }
  saveCit(projectId: string, input: { namespace: string; rules: CitRule[]; baseVersions: Record<string, number> }): Promise<{ rules: number; saved: number; deleted: number; problems: StudioProblem[] }> { return this.request(`/api/v1/projects/${projectId}/cit`, { method: "PUT", body: JSON.stringify(input) }); }
  saveCitRaw(projectId: string, input: { path: string; baseVersion: number; json: string }): Promise<{ path: string; version: number; size: number; sha256: string }> { return this.request(`/api/v1/projects/${projectId}/cit/raw`, { method: "PUT", body: JSON.stringify(input) }); }
  listSnapshots(projectId: string): Promise<SnapshotRecord[]> { return this.request(`/api/v1/projects/${projectId}/snapshots`); }
  createSnapshot(projectId: string, label: string): Promise<SnapshotRecord> { return this.request(`/api/v1/projects/${projectId}/snapshots`, { method: "POST", body: JSON.stringify({ label }) }); }
  rollbackSnapshot(projectId: string, snapshotId: string): Promise<{ snapshotId: string; restoredFiles: number }> { return this.request(`/api/v1/projects/${projectId}/snapshots/${snapshotId}/rollback`, { method: "POST" }); }
  listBuilds(projectId: string): Promise<BuildRecord[]> { return this.request(`/api/v1/projects/${projectId}/builds`); }
  startBuild(projectId: string, profile: "development" | "release", label?: string): Promise<BuildRecord> { return this.request(`/api/v1/projects/${projectId}/builds`, { method: "POST", body: JSON.stringify({ profile, ...(label ? { label } : {}) }) }); }
  buildDetail(projectId: string, buildId: string): Promise<BuildRecord> { return this.request(`/api/v1/projects/${projectId}/builds/${buildId}`); }
  presence(projectId: string): Promise<PresenceUser[]> { return this.request(`/api/v1/projects/${projectId}/presence`); }
  listLocks(projectId: string): Promise<FileLock[]> { return this.request(`/api/v1/projects/${projectId}/locks`); }
  acquireLock(projectId: string, path: string): Promise<{ fileId: string; path: string; token: string; expiresAt: string }> { return this.request(`/api/v1/projects/${projectId}/locks`, { method: "POST", body: JSON.stringify({ path }) }); }
  heartbeatLock(projectId: string, fileId: string, token: string): Promise<{ expiresAt: string }> { return this.request(`/api/v1/projects/${projectId}/locks/${fileId}/heartbeat`, { method: "PATCH", body: JSON.stringify({ token }) }); }
  releaseLock(projectId: string, fileId: string, token: string): Promise<void> { return this.request(`/api/v1/projects/${projectId}/locks/${fileId}`, { method: "DELETE", body: JSON.stringify({ token }) }); }
  forceReleaseLock(projectId: string, fileId: string): Promise<void> { return this.request(`/api/v1/projects/${projectId}/locks/${fileId}?force=true`, { method: "DELETE" }); }
  listMembers(projectId: string): Promise<ProjectMember[]> { return this.request(`/api/v1/projects/${projectId}/members`); }
  setMember(projectId: string, username: string, role: Exclude<ProjectMember["role"], "owner">): Promise<{ userId: string; role: string }> { return this.request(`/api/v1/projects/${projectId}/members`, { method: "PUT", body: JSON.stringify({ username, role }) }); }
  removeMember(projectId: string, userId: string): Promise<void> { return this.request(`/api/v1/projects/${projectId}/members/${userId}`, { method: "DELETE" }); }
  listComments(projectId: string, resolved: "all" | "open" | "resolved" = "open"): Promise<ProjectComment[]> { return this.request(`/api/v1/projects/${projectId}/comments?resolved=${resolved}`); }
  createComment(projectId: string, input: { body: string; filePath?: string; logicalItemId?: string }): Promise<{ id: string }> { return this.request(`/api/v1/projects/${projectId}/comments`, { method: "POST", body: JSON.stringify(input) }); }
  resolveComment(projectId: string, commentId: string, resolved: boolean): Promise<{ id: string; resolved: boolean }> { return this.request(`/api/v1/projects/${projectId}/comments/${commentId}/resolve`, { method: "PATCH", body: JSON.stringify({ resolved }) }); }
  activity(projectId: string): Promise<ActivityEntry[]> { return this.request(`/api/v1/projects/${projectId}/activity`); }
  notifications(unreadOnly = false): Promise<StudioNotification[]> { return this.request(`/api/v1/notifications?unreadOnly=${unreadOnly}`); }
  readNotification(id: string): Promise<{ readAt: string }> { return this.request(`/api/v1/notifications/${id}/read`, { method: "PATCH" }); }
  listReviews(projectId: string): Promise<ReviewRecord[]> { return this.request(`/api/v1/projects/${projectId}/reviews`); }
  reviewDetail(projectId: string, reviewId: string): Promise<ReviewDetail> { return this.request(`/api/v1/projects/${projectId}/reviews/${reviewId}`); }
  reviewTextDiff(projectId: string, reviewId: string, path: string): Promise<ReviewTextDiff> { return this.request(`/api/v1/projects/${projectId}/reviews/${reviewId}/text-diff?path=${encodeURIComponent(path)}`); }
  createReview(projectId: string, input: { snapshotId: string; baseSnapshotId?: string | null; title: string; description: string }): Promise<{ id: string; status: ReviewStatus }> { return this.request(`/api/v1/projects/${projectId}/reviews`, { method: "POST", body: JSON.stringify(input) }); }
  decideReview(projectId: string, reviewId: string, action: "approve" | "request_changes" | "resubmit" | "cancel", note = "", snapshotId?: string): Promise<{ id: string; status: ReviewStatus }> { return this.request(`/api/v1/projects/${projectId}/reviews/${reviewId}/decision`, { method: "POST", body: JSON.stringify({ action, note, ...(snapshotId ? { snapshotId } : {}) }) }); }
  listReleases(projectId: string): Promise<ReleaseRecord[]> { return this.request(`/api/v1/projects/${projectId}/releases`); }
  publishRelease(projectId: string, input: { buildId: string; approvedReviewId: string; version: string; releaseNotes: string }): Promise<{ id: string; version: string; artifactSha256: string; artifactSize: string }> { return this.request(`/api/v1/projects/${projectId}/releases`, { method: "POST", body: JSON.stringify(input) }); }
  async connectRealtime(projectId: string, onEvent: (event: RealtimeEvent) => void): Promise<() => void> {
    let stopped = false; let socket: WebSocket | null = null; let reconnect = 0; let heartbeat = 0;
    const open = async () => { const { ticket } = await this.request<{ ticket: string }>(`/api/v1/projects/${projectId}/realtime-ticket`, { method: "POST" }); if (stopped) return; const url = realtimeWebSocketUrl(this.baseUrl, projectId, ticket); socket = new WebSocket(url); heartbeat = window.setInterval(() => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "presence.heartbeat" })); }, 25_000); socket.onmessage = (message) => { try { onEvent(JSON.parse(String(message.data)) as RealtimeEvent); } catch { /* ignore malformed frames */ } }; socket.onclose = () => { window.clearInterval(heartbeat); if (!stopped) reconnect = window.setTimeout(() => void open().catch(() => { reconnect = window.setTimeout(() => void open().catch(() => undefined), 5000); }), 1500); }; };
    await open(); return () => { stopped = true; window.clearInterval(heartbeat); window.clearTimeout(reconnect); socket?.close(1000, "Project closed"); };
  }
  async buildArtifact(projectId: string, buildId: string): Promise<Blob> {
    const path = `/api/v1/projects/${projectId}/builds/${buildId}/artifact`; let response = await fetch(`${this.baseUrl}${path}`, { headers: { Authorization: `Bearer ${this.accessToken}` } });
    if (response.status === 401 && this.refreshToken) { this.refreshRequest ??= this.refresh().finally(() => { this.refreshRequest = null; }); await this.refreshRequest; response = await fetch(`${this.baseUrl}${path}`, { headers: { Authorization: `Bearer ${this.accessToken}` } }); }
    if (!response.ok) { const data = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } }; throw new ApiError(data.error?.code ?? "HTTP_ERROR", data.error?.message ?? `HTTP ${response.status}`, response.status); } return response.blob();
  }
  async releaseArtifact(projectId: string, releaseId: string): Promise<Blob> {
    const path = `/api/v1/projects/${projectId}/releases/${releaseId}/artifact`; let response = await fetch(`${this.baseUrl}${path}`, { headers: { Authorization: `Bearer ${this.accessToken}` } });
    if (response.status === 401 && this.refreshToken) { this.refreshRequest ??= this.refresh().finally(() => { this.refreshRequest = null; }); await this.refreshRequest; response = await fetch(`${this.baseUrl}${path}`, { headers: { Authorization: `Bearer ${this.accessToken}` } }); }
    if (!response.ok) { const data = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } }; throw new ApiError(data.error?.code ?? "HTTP_ERROR", data.error?.message ?? `HTTP ${response.status}`, response.status); } return response.blob();
  }
  files(projectId: string): Promise<{ tree: ProjectFile[]; count: number }> { return this.request(`/api/v1/projects/${projectId}/files`); }
  async importZip(projectId: string, file: File): Promise<ImportReport> { const form = new FormData(); form.set("file", file, file.name); return this.request(`/api/v1/projects/${projectId}/import`, { method: "POST", body: form }); }
  async createFile(projectId: string, path: string, file: File): Promise<{ path: string; version: number; size: number; sha256: string; mimeType: string }> { const form = new FormData(); form.set("path", path); form.set("file", file, file.name); return this.request(`/api/v1/projects/${projectId}/files/create`, { method: "POST", body: form }); }
  async saveFile(projectId: string, path: string, baseVersion: number, file: Blob): Promise<{ path: string; version: number; size: number; sha256: string }> { const form = new FormData(); form.set("path", path); form.set("baseVersion", String(baseVersion)); form.set("file", file, path.split("/").pop() ?? "texture.png"); return this.request(`/api/v1/projects/${projectId}/files/save`, { method: "POST", body: form }); }
  async content(projectId: string, path: string): Promise<Blob> {
    let response = await fetch(`${this.baseUrl}/api/v1/projects/${projectId}/files/content?path=${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${this.accessToken}` } });
    if (response.status === 401 && this.refreshToken) {
      this.refreshRequest ??= this.refresh().finally(() => { this.refreshRequest = null; });
      await this.refreshRequest;
      response = await fetch(`${this.baseUrl}/api/v1/projects/${projectId}/files/content?path=${encodeURIComponent(path)}`, { headers: { Authorization: `Bearer ${this.accessToken}` } });
    }
    if (!response.ok) { const data = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } }; throw new ApiError(data.error?.code ?? "HTTP_ERROR", data.error?.message ?? `HTTP ${response.status}`, response.status); }
    return await response.blob();
  }
}
