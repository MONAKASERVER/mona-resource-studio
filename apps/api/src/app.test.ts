import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "./db/pool.js";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const opened: Array<Awaited<ReturnType<typeof createApp>>> = [];
afterEach(async () => { await Promise.all(opened.splice(0).map((app) => app.close())); });

describe("API shell", () => {
  it("exposes process health without touching the database", async () => {
    const db = { query: vi.fn() } as unknown as Database;
    const app = await createApp(loadConfig({ NODE_ENV: "test", DATA_ROOT: ".data-test" }), db); opened.push(app);
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("allows the fixed Tauri desktop origin", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test", DATA_ROOT: ".data-test" }), { query: vi.fn() } as unknown as Database); opened.push(app);
    const response = await app.inject({ method: "OPTIONS", url: "/api/v1/projects", headers: { origin: "http://tauri.localhost", "access-control-request-method": "GET" } });
    expect(response.statusCode).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://tauri.localhost");
  });

  it("applies the API problem envelope to errors raised inside prefixed routes", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as Database;
    const app = await createApp(loadConfig({ NODE_ENV: "test", DATA_ROOT: ".data-test" }), db); opened.push(app);
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "missing", password: "invalid" } });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: { code: "INVALID_CREDENTIALS", message: "ユーザー名またはパスワードが違います。" } });
  });

  it("accepts bodyless JSON requests from v0.1.1 desktop clients", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test", DATA_ROOT: ".data-test" }), { query: vi.fn() } as unknown as Database); opened.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/projects/00000000-0000-0000-0000-000000000000/realtime-ticket",
      headers: { "content-type": "application/json", "content-length": "0" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "AUTH_REQUIRED" } });
  });

  it("does not turn malformed client JSON into an internal server error", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test", DATA_ROOT: ".data-test" }), { query: vi.fn() } as unknown as Database); opened.push(app);
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/login", headers: { "content-type": "application/json" }, payload: "{" });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "FST_ERR_CTP_INVALID_JSON_BODY" } });
  });
});
