import { afterEach, describe, expect, it, vi } from "vitest";
import argon2 from "argon2";
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

  it("starts passkey login with the browser secret in the URL fragment", async () => {
    const flowId = "00000000-0000-4000-8000-000000000001";
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: flowId }], rowCount: 1 }) } as unknown as Database;
    const app = await createApp(loadConfig({ NODE_ENV: "test", DATA_ROOT: ".data-test" }), db); opened.push(app);
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/passkey/login/start" });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ flowId: string; pollToken: string; browserUrl: string }>();
    const browserUrl = new URL(body.browserUrl);
    expect(body.flowId).toBe(flowId);
    expect(body.pollToken.length).toBeGreaterThan(32);
    expect(browserUrl.searchParams.get("flow")).toBe(flowId);
    expect(browserUrl.searchParams.has("token")).toBe(false);
    expect(new URLSearchParams(browserUrl.hash.slice(1)).get("token")?.length).toBeGreaterThan(32);
  });

  it("serves the passkey ceremony with restrictive browser headers", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ exists: 1 }], rowCount: 1 }) } as unknown as Database;
    const app = await createApp(loadConfig({ NODE_ENV: "test", DATA_ROOT: ".data-test" }), db); opened.push(app);
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/passkey/ceremony?flow=00000000-0000-4000-8000-000000000001" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.body).toContain("パスキー認証");
  });

  it("advertises passkey support without touching the database", async () => {
    const db = { query: vi.fn() } as unknown as Database;
    const app = await createApp(loadConfig({ NODE_ENV: "test", DATA_ROOT: ".data-test" }), db); opened.push(app);
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/passkey/status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ enabled: true, rpId: "localhost" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("updates the authenticated user's display name", async () => {
    const user = { id: "00000000-0000-4000-8000-000000000010", username: "tester", display_name: "新しい表示名", system_role: "user" as const };
    const query = vi.fn(async (sql: string) => sql.startsWith("UPDATE users") ? { rows: [user], rowCount: 1 } : { rows: [], rowCount: 1 });
    const db = { query } as unknown as Database;
    const app = await createApp(loadConfig({ NODE_ENV: "test", DATA_ROOT: ".data-test" }), db); opened.push(app);
    const token = app.jwt.sign({ sub: user.id, username: user.username, systemRole: user.system_role });
    const response = await app.inject({ method: "PATCH", url: "/api/v1/auth/profile", headers: { authorization: `Bearer ${token}` }, payload: { displayName: "  新しい表示名  " } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ id: user.id, username: user.username, displayName: "新しい表示名", systemRole: "user" });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("UPDATE users"), [user.id, "新しい表示名"]);
  });

  it("changes the password and replaces all existing refresh sessions", async () => {
    const user = { id: "00000000-0000-4000-8000-000000000011", username: "tester", display_name: "Tester", password_hash: await argon2.hash("current-password"), system_role: "user" as const };
    let storedHash = "";
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.startsWith("SELECT id, username")) return { rows: [user], rowCount: 1 };
        if (sql.startsWith("UPDATE users")) { storedHash = String(values?.[1]); return { rows: [], rowCount: 1 }; }
        if (sql.startsWith("INSERT INTO refresh_tokens")) return { rows: [{ id: "00000000-0000-4000-8000-000000000012" }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const db = { query: vi.fn(), connect: vi.fn(async () => client) } as unknown as Database;
    const app = await createApp(loadConfig({ NODE_ENV: "test", DATA_ROOT: ".data-test" }), db); opened.push(app);
    const token = app.jwt.sign({ sub: user.id, username: user.username, systemRole: user.system_role });
    const response = await app.inject({ method: "POST", url: "/api/v1/auth/password", headers: { authorization: `Bearer ${token}` }, payload: { currentPassword: "current-password", newPassword: "new-password-12345" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { id: user.id, username: user.username, displayName: "Tester" } });
    await expect(argon2.verify(storedHash, "new-password-12345")).resolves.toBe(true);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE refresh_tokens SET revoked_at"), [user.id]);
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
