import { hasPermission, type Permission, type ProjectRole } from "@mona/shared";
import type { Database } from "./db/pool.js";
import { AppError } from "./errors.js";

export async function requireProjectPermission(db: Database, user: { sub: string; systemRole: "admin" | "user" }, projectId: string, permission: Permission): Promise<ProjectRole> {
  if (user.systemRole === "admin") return "admin";
  const result = await db.query<{ role: ProjectRole }>("SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2", [projectId, user.sub]);
  const role = result.rows[0]?.role;
  if (!role) throw new AppError(404, "PROJECT_NOT_FOUND", "プロジェクトが見つかりません。");
  if (!hasPermission(role, permission)) throw new AppError(403, "PROJECT_FORBIDDEN", "この操作を行う権限がありません。");
  return role;
}

