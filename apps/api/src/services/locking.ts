import type { PoolClient } from "pg";
import { AppError } from "../errors.js";

export async function assertPathsWritable(db: Pick<PoolClient, "query">, projectId: string, paths: readonly string[], userId: string): Promise<void> {
  if (!paths.length) return;
  const result = await db.query<{ path: string; display_name: string; username: string }>(`SELECT pf.path, u.display_name, u.username FROM file_locks fl JOIN project_files pf ON pf.id = fl.file_id JOIN users u ON u.id = fl.owner_id WHERE pf.project_id = $1 AND pf.path = ANY($2::text[]) AND fl.expires_at > now() AND fl.owner_id <> $3 LIMIT 1`, [projectId, paths, userId]); const lock = result.rows[0];
  if (lock) throw new AppError(423, "FILE_LOCKED", `${lock.display_name} が編集中のため、${lock.path} は閲覧専用です。`, lock);
}
