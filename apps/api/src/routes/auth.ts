import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Database } from "../db/pool.js";
import { createSession, hashToken, requireUser } from "../auth.js";
import { AppError } from "../errors.js";

const loginSchema = z.object({ username: z.string().min(3).max(32), password: z.string().min(1).max(512) });
const refreshSchema = z.object({ refreshToken: z.string().min(32).max(512) });

export async function authRoutes(app: FastifyInstance, db: Database): Promise<void> {
  app.post("/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (request) => {
    const body = loginSchema.parse(request.body);
    const result = await db.query<{ id: string; username: string; display_name: string; password_hash: string; system_role: "admin" | "user" }>(
      "SELECT id, username, display_name, password_hash, system_role FROM users WHERE lower(username) = lower($1) AND disabled_at IS NULL",
      [body.username],
    );
    const user = result.rows[0];
    if (!user || !await argon2.verify(user.password_hash, body.password)) throw new AppError(401, "INVALID_CREDENTIALS", "ユーザー名またはパスワードが違います。");
    const session = await createSession(app, db, user);
    await db.query("INSERT INTO activity_logs (actor_id, action, target_type, target_id, ip, user_agent) VALUES ($1::uuid, 'auth.login', 'user', ($1::uuid)::text, $2, $3)", [user.id, request.ip, request.headers["user-agent"] ?? null]);
    return { ...session, user: { id: user.id, username: user.username, displayName: user.display_name, systemRole: user.system_role } };
  });

  app.post("/auth/refresh", async (request) => {
    const body = refreshSchema.parse(request.body); const tokenHash = hashToken(body.refreshToken); const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string; user_id: string; username: string; system_role: "admin" | "user" }>(
        `SELECT rt.id, rt.user_id, u.username, u.system_role FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
         WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > now() AND u.disabled_at IS NULL FOR UPDATE OF rt`, [tokenHash],
      );
      const old = result.rows[0]; if (!old) throw new AppError(401, "REFRESH_INVALID", "セッションの有効期限が切れました。");
      const session = await createSession(app, client, { id: old.user_id, username: old.username, system_role: old.system_role });
      await client.query("UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1", [old.id, session.refreshTokenId]);
      await client.query("COMMIT"); return session;
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  });

  app.post("/auth/logout", async (request, reply) => {
    const body = refreshSchema.parse(request.body); await db.query("UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1", [hashToken(body.refreshToken)]);
    reply.code(204).send();
  });

  app.get("/auth/me", async (request) => {
    const token = await requireUser(request);
    const result = await db.query<{ id: string; username: string; display_name: string; system_role: "admin" | "user" }>("SELECT id, username, display_name, system_role FROM users WHERE id = $1 AND disabled_at IS NULL", [token.sub]);
    const user = result.rows[0]; if (!user) throw new AppError(401, "USER_DISABLED", "ユーザーを利用できません。");
    return { id: user.id, username: user.username, displayName: user.display_name, systemRole: user.system_role };
  });
}
