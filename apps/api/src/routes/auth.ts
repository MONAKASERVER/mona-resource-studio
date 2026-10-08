import argon2 from "argon2";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/pool.js";
import { createSession, hashToken, requireUser } from "../auth.js";
import { AppError } from "../errors.js";
import { passkeyRoutes } from "./passkeys.js";

const loginSchema = z.object({ username: z.string().min(3).max(32), password: z.string().min(1).max(512) });
const refreshSchema = z.object({ refreshToken: z.string().min(32).max(512) });
const profileSchema = z.object({ displayName: z.string().trim().min(1).max(64) });
const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(12).max(128),
});

export async function authRoutes(app: FastifyInstance, db: Database, config: AppConfig): Promise<void> {
  await passkeyRoutes(app, db, config);
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

  app.patch("/auth/profile", async (request) => {
    const token = await requireUser(request);
    const body = profileSchema.parse(request.body);
    const result = await db.query<{ id: string; username: string; display_name: string; system_role: "admin" | "user" }>(
      `UPDATE users SET display_name = $2, updated_at = now()
       WHERE id = $1 AND disabled_at IS NULL
       RETURNING id, username, display_name, system_role`,
      [token.sub, body.displayName],
    );
    const user = result.rows[0];
    if (!user) throw new AppError(401, "USER_DISABLED", "ユーザーを利用できません。");
    await db.query(
      "INSERT INTO activity_logs (actor_id, action, target_type, target_id, metadata, ip, user_agent) VALUES ($1::uuid, 'auth.profile.updated', 'user', ($1::uuid)::text, $2, $3, $4)",
      [user.id, JSON.stringify({ displayName: user.display_name }), request.ip, request.headers["user-agent"] ?? null],
    );
    return { id: user.id, username: user.username, displayName: user.display_name, systemRole: user.system_role };
  });

  app.post("/auth/password", { config: { rateLimit: { max: 5, timeWindow: "5 minutes" } } }, async (request) => {
    const token = await requireUser(request);
    const body = passwordSchema.parse(request.body);
    if (body.currentPassword === body.newPassword) throw new AppError(400, "PASSWORD_UNCHANGED", "現在と異なるパスワードを設定してください。");

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ id: string; username: string; display_name: string; password_hash: string; system_role: "admin" | "user" }>(
        "SELECT id, username, display_name, password_hash, system_role FROM users WHERE id = $1 AND disabled_at IS NULL FOR UPDATE",
        [token.sub],
      );
      const user = result.rows[0];
      if (!user) throw new AppError(401, "USER_DISABLED", "ユーザーを利用できません。");
      if (!await argon2.verify(user.password_hash, body.currentPassword)) throw new AppError(400, "CURRENT_PASSWORD_INVALID", "現在のパスワードが違います。");

      const passwordHash = await argon2.hash(body.newPassword, { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 1 });
      await client.query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", [user.id, passwordHash]);
      await client.query("UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [user.id]);
      const session = await createSession(app, client, user);
      await client.query(
        "INSERT INTO activity_logs (actor_id, action, target_type, target_id, ip, user_agent) VALUES ($1::uuid, 'auth.password.changed', 'user', ($1::uuid)::text, $2, $3)",
        [user.id, request.ip, request.headers["user-agent"] ?? null],
      );
      await client.query("COMMIT");
      return { ...session, user: { id: user.id, username: user.username, displayName: user.display_name, systemRole: user.system_role } };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
