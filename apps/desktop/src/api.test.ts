import { afterEach, describe, expect, it, vi } from "vitest";
import { StudioApi } from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("StudioApi token rotation", () => {
  it("coalesces concurrent refreshes and retries requests once", async () => {
    let refreshCalls = 0;
    const onTokens = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/v1/auth/refresh")) {
        refreshCalls += 1;
        await Promise.resolve();
        return new Response(JSON.stringify({ accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 900 }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const authorization = new Headers(init?.headers).get("Authorization");
      if (authorization !== "Bearer new-access") return new Response(JSON.stringify({ error: { code: "AUTH_REQUIRED", message: "expired" } }), { status: 401, headers: { "Content-Type": "application/json" } });
      return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    const api = new StudioApi("http://localhost:4100", "", onTokens);
    api.setTokens("old-access", "old-refresh");
    await Promise.all([api.listProjects(), api.listProjects()]);

    expect(refreshCalls).toBe(1);
    expect(onTokens).toHaveBeenCalledWith("new-access", "new-refresh");
  });
});
