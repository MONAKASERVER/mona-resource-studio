import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import type { Database } from "./db/pool.js";
import { AppError } from "./errors.js";
import { authRoutes } from "./routes/auth.js";
import { projectRoutes } from "./routes/projects.js";
import { itemRoutes } from "./routes/items.js";
import { citRoutes } from "./routes/cit.js";
import { buildRoutes } from "./routes/builds.js";
import { collaborationRoutes } from "./routes/collaboration.js";
import { reviewRoutes } from "./routes/reviews.js";
import { ProjectStorage } from "./services/storage.js";
import { BuildServices } from "./services/builds.js";
import { RealtimeHub } from "./services/realtime.js";

export async function createApp(config: AppConfig, db: Database) {
  const app = Fastify({ logger: { level: config.NODE_ENV === "test" ? "silent" : "info", redact: ["req.headers.authorization", "req.body.password", "req.body.refreshToken", "req.body.token", "req.query.ticket"] }, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cors, {
    origin: [config.DESKTOP_ORIGIN, "http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"],
    credentials: false,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  await app.register(jwt, { secret: config.JWT_ACCESS_SECRET });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute", keyGenerator: (request) => request.ip });
  await app.register(multipart, { limits: { files: 1, fileSize: 100 * 1024 * 1024, fields: 4 } });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async () => { await db.query("SELECT 1"); return { status: "ready" }; });
  const storage = new ProjectStorage(config.DATA_ROOT);
  const builds = new BuildServices(config.REDIS_URL, { endpoint: config.MINIO_ENDPOINT, accessKey: config.MINIO_ACCESS_KEY, secretKey: config.MINIO_SECRET_KEY, bucket: config.MINIO_BUCKET });
  const realtime = new RealtimeHub(config.REDIS_URL);
  app.addHook("onClose", async () => { await Promise.all([builds.close(), realtime.close()]); });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: "NOT_FOUND", message: "API endpointが見つかりません。" } }));
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) { reply.code(error.statusCode).send({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } }); return; }
    if (error instanceof ZodError) { reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "入力内容を確認してください。", details: error.issues } }); return; }
    if ((error as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") { reply.code(413).send({ error: { code: "ZIP_TOO_LARGE", message: "ZIPが100MiBを超えています。" } }); return; }
    request.log.error(error); reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "サーバー内部でエラーが発生しました。" } });
  });
  await app.register(async (api) => { await authRoutes(api, db); await projectRoutes(api, db, storage, realtime); await itemRoutes(api, db, realtime); await citRoutes(api, db, storage, realtime); await buildRoutes(api, db, storage, builds, realtime); await collaborationRoutes(api, db, realtime); await reviewRoutes(api, db, builds, realtime); }, { prefix: "/api/v1" });
  return app;
}
