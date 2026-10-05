import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Database } from "./db/pool.js";
import { AppError } from "./errors.js";

export const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

type QueryExecutor = Pick<Database, "query">;

export async function createSession(app: FastifyInstance, db: QueryExecutor, user: { id: string; username: string; system_role: "admin" | "user" }) {
  const refreshToken = randomBytes(48).toString("base64url");
  const result = await db.query<{ id: string }>(
    "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '30 days') RETURNING id",
    [user.id, hashToken(refreshToken)],
  );
  return {
    accessToken: app.jwt.sign({ sub: user.id, username: user.username, systemRole: user.system_role }, { expiresIn: "15m" }),
    refreshToken,
    refreshTokenId: result.rows[0]!.id,
    expiresIn: 900,
  };
}

export async function requireUser(request: FastifyRequest) {
  try { await request.jwtVerify(); }
  catch { throw new AppError(401, "AUTH_REQUIRED", "ログインが必要です。"); }
  return request.user;
}
