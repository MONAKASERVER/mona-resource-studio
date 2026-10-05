export type ProjectRole = "owner" | "admin" | "manager" | "editor" | "viewer";

export type Permission =
  | "project.read" | "file.read" | "file.write" | "project.import"
  | "member.manage" | "lock.forceRelease" | "review.request" | "review.decide"
  | "build.run" | "release.publish" | "comment.write";

const ROLE_PERMISSIONS: Readonly<Record<ProjectRole, ReadonlySet<Permission>>> = {
  owner: new Set(["project.read", "file.read", "file.write", "project.import", "member.manage", "lock.forceRelease", "review.request", "review.decide", "build.run", "release.publish", "comment.write"]),
  admin: new Set(["project.read", "file.read", "file.write", "project.import", "member.manage", "lock.forceRelease", "review.request", "review.decide", "build.run", "release.publish", "comment.write"]),
  manager: new Set(["project.read", "file.read", "file.write", "project.import", "lock.forceRelease", "review.request", "review.decide", "build.run", "comment.write"]),
  editor: new Set(["project.read", "file.read", "file.write", "project.import", "review.request", "comment.write"]),
  viewer: new Set(["project.read", "file.read", "comment.write"]),
};

export function hasPermission(role: ProjectRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export type ProblemSeverity = "error" | "warning" | "info";
export interface StudioProblem {
  severity: ProblemSeverity;
  code: string;
  message: string;
  path?: string | undefined;
  line?: number | undefined;
  hint?: string | undefined;
}

export interface SessionUser { id: string; username: string; displayName: string; systemRole: "admin" | "user"; }
export interface ProjectSummary { id: string; name: string; description: string; minecraftVersion: string; role: ProjectRole; updatedAt: string; fileCount: number; }
export interface ProjectFile { path: string; name: string; kind: "file" | "directory"; size: number; mimeType: string | null; version?: number; children?: ProjectFile[]; }
export interface ImportReport { fileCount: number; totalBytes: number; namespaces: string[]; textures: number; models: number; jsonFiles: number; problems: StudioProblem[]; }
