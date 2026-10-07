import { randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/pool.js";
import { createSession, hashToken, requireUser } from "../auth.js";
import { AppError } from "../errors.js";

const FLOW_LIFETIME_MINUTES = 5;
const flowSchema = z.object({ flowId: z.string().uuid(), token: z.string().min(32).max(512) });
const completionSchema = flowSchema.extend({ response: z.unknown() });
const registrationSchema = z.object({ name: z.string().trim().min(1).max(64).default("マイパスキー") });
const credentialParams = z.object({ id: z.string().min(16).max(2048) });

interface FlowRow {
  id: string;
  kind: "login" | "register";
  user_id: string | null;
  challenge: string;
  options: Record<string, unknown>;
  credential_name: string | null;
  attempted_at: Date | null;
  completed_at: Date | null;
  consumed_at: Date | null;
}

interface CredentialRow {
  id: string;
  user_id: string;
  public_key: Buffer;
  counter: string;
  transports: string[];
  username: string;
  display_name: string;
  system_role: "admin" | "user";
}

const newToken = (): string => randomBytes(32).toString("base64url");

function browserPage(flowId: string): string {
  const safeFlowId = JSON.stringify(flowId);
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mona Resource Studio パスキー認証</title>
<style>
:root{color-scheme:dark;font-family:Inter,"Noto Sans JP",system-ui,sans-serif;background:#090e13;color:#e4ebf0}*{box-sizing:border-box}body{min-height:100vh;margin:0;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 20% 10%,#153d3266,transparent 38%),#090e13}.card{width:min(440px,100%);padding:34px;border:1px solid #25323d;border-radius:16px;background:linear-gradient(145deg,#111a22,#0d1319);box-shadow:0 25px 80px #0009}.mark{width:48px;height:48px;display:grid;place-items:center;border:1px solid #67e8b244;border-radius:12px;background:#67e8b215;color:#67e8b2;font-size:24px}h1{margin:22px 0 8px;font-size:22px}p{margin:0 0 24px;color:#91a0ad;font-size:14px;line-height:1.7}button{width:100%;min-height:46px;border:1px solid #4ba986;border-radius:8px;background:#1a634a;color:#e9fff6;font-weight:700;cursor:pointer}button:disabled{opacity:.55;cursor:wait}.status{display:none;margin-top:16px;padding:12px;border:1px solid #31404b;border-radius:7px;color:#9cabb7;font-size:13px;line-height:1.55}.status.show{display:block}.status.ok{border-color:#34745c;background:#14372b;color:#a9ebd0}.status.error{border-color:#7a3a47;background:#341b23;color:#ffb0bd}small{display:block;margin-top:20px;color:#5f6d78;text-align:center}
</style></head><body><main class="card"><div class="mark">◇</div><h1>パスキー認証</h1><p>Windows Hello、スマートフォン、またはセキュリティキーを使ってMona Resource Studioの認証を完了します。</p><button id="begin">パスキーを使用する</button><div id="status" class="status" role="status"></div><small>この画面は5分で期限切れになります。</small></main>
<script>
const state={flowId:${safeFlowId},token:new URLSearchParams(location.hash.slice(1)).get('token')||''};history.replaceState(null,'',location.pathname+'?flow='+encodeURIComponent(state.flowId));const button=document.querySelector('#begin'); const status=document.querySelector('#status');
const show=(message,type='')=>{status.textContent=message;status.className='status show '+type};
const b64=(buffer)=>{const bytes=new Uint8Array(buffer);let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return btoa(binary).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'')};
const bytes=(value)=>{const base64=value.replaceAll('-','+').replaceAll('_','/').padEnd(Math.ceil(value.length/4)*4,'=');const binary=atob(base64);return Uint8Array.from(binary,c=>c.charCodeAt(0))};
const fallbackOptions=(json)=>{const options={...json,challenge:bytes(json.challenge)};if(json.user)options.user={...json.user,id:bytes(json.user.id)};if(json.excludeCredentials)options.excludeCredentials=json.excludeCredentials.map(c=>({...c,id:bytes(c.id)}));if(json.allowCredentials)options.allowCredentials=json.allowCredentials.map(c=>({...c,id:bytes(c.id)}));return options};
const jsonify=(credential)=>{if(credential.toJSON)return credential.toJSON();const response=credential.response;const out={id:credential.id,rawId:b64(credential.rawId),type:credential.type,authenticatorAttachment:credential.authenticatorAttachment??undefined,clientExtensionResults:credential.getClientExtensionResults()};if(response.attestationObject){out.response={clientDataJSON:b64(response.clientDataJSON),attestationObject:b64(response.attestationObject),transports:response.getTransports?.(),publicKeyAlgorithm:response.getPublicKeyAlgorithm?.(),publicKey:response.getPublicKey?.()?b64(response.getPublicKey()):undefined};}else{out.response={clientDataJSON:b64(response.clientDataJSON),authenticatorData:b64(response.authenticatorData),signature:b64(response.signature),userHandle:response.userHandle?b64(response.userHandle):undefined};}return out};
button.addEventListener('click',async()=>{button.disabled=true;show('端末の認証画面を確認してください。');try{const optionsResponse=await fetch('./browser/options',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(state)});const payload=await optionsResponse.json();if(!optionsResponse.ok)throw new Error(payload?.error?.message||'認証を開始できませんでした。');let credential;if(payload.kind==='register'){const publicKey=PublicKeyCredential.parseCreationOptionsFromJSON?PublicKeyCredential.parseCreationOptionsFromJSON(payload.options):fallbackOptions(payload.options);credential=await navigator.credentials.create({publicKey});}else{const publicKey=PublicKeyCredential.parseRequestOptionsFromJSON?PublicKeyCredential.parseRequestOptionsFromJSON(payload.options):fallbackOptions(payload.options);credential=await navigator.credentials.get({publicKey});}if(!credential)throw new Error('パスキーが選択されませんでした。');const finish=await fetch('./browser/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...state,response:jsonify(credential)})});const result=await finish.json();if(!finish.ok)throw new Error(result?.error?.message||'パスキーを確認できませんでした。');show(payload.kind==='register'?'パスキーを登録しました。アプリへ戻ってください。':'認証が完了しました。アプリへ戻ってください。','ok');button.remove();setTimeout(()=>window.close(),1800);}catch(error){show(error?.name==='NotAllowedError'?'認証がキャンセルされたか、時間切れになりました。':String(error?.message||error),'error');button.disabled=false;}});
</script></body></html>`;
}

async function readFlow(db: Database, body: z.infer<typeof flowSchema>): Promise<FlowRow> {
  const result = await db.query<FlowRow>(
    `SELECT id,kind,user_id,challenge,options,credential_name,attempted_at,completed_at,consumed_at FROM passkey_flows
     WHERE id=$1 AND browser_token_hash=$2 AND expires_at>now()`,
    [body.flowId, hashToken(body.token)],
  );
  const flow = result.rows[0];
  if (!flow) throw new AppError(410, "PASSKEY_FLOW_EXPIRED", "認証の有効期限が切れました。アプリからやり直してください。");
  return flow;
}

export async function passkeyRoutes(app: FastifyInstance, db: Database, config: AppConfig): Promise<void> {
  app.get("/auth/passkey/status", async () => ({ enabled: true, rpId: config.PASSKEY_RP_ID }));

  app.post("/auth/passkey/login/start", { config: { rateLimit: { max: 8, timeWindow: "1 minute" } } }, async () => {
    const options = await generateAuthenticationOptions({ rpID: config.PASSKEY_RP_ID, userVerification: "required", allowCredentials: [], timeout: 120_000 });
    const browserToken = newToken(); const pollToken = newToken();
    const created = await db.query<{ id: string }>(
      `INSERT INTO passkey_flows(kind,challenge,options,browser_token_hash,poll_token_hash,expires_at)
       VALUES('login',$1,$2,$3,$4,now()+interval '${FLOW_LIFETIME_MINUTES} minutes') RETURNING id`,
      [options.challenge, JSON.stringify(options), hashToken(browserToken), hashToken(pollToken)],
    );
    const flowId = created.rows[0]!.id; const url = new URL(`${config.PASSKEY_PUBLIC_API_URL.replace(/\/$/, "")}/api/v1/auth/passkey/ceremony`);
    url.searchParams.set("flow", flowId); url.hash = `token=${encodeURIComponent(browserToken)}`;
    return { flowId, pollToken, browserUrl: url.toString(), expiresIn: FLOW_LIFETIME_MINUTES * 60 };
  });

  app.post("/auth/passkey/register/start", async (request) => {
    const token = await requireUser(request); const body = registrationSchema.parse(request.body ?? {});
    const userResult = await db.query<{ id: string; username: string; display_name: string }>("SELECT id,username,display_name FROM users WHERE id=$1 AND disabled_at IS NULL", [token.sub]);
    const user = userResult.rows[0]; if (!user) throw new AppError(401, "USER_DISABLED", "ユーザーを利用できません。");
    const credentials = await db.query<{ id: string; transports: string[] }>("SELECT id,transports FROM passkey_credentials WHERE user_id=$1", [user.id]);
    const options = await generateRegistrationOptions({
      rpName: "Mona Resource Studio", rpID: config.PASSKEY_RP_ID, userName: user.username, userDisplayName: user.display_name,
      userID: new TextEncoder().encode(user.id), attestationType: "none", timeout: 120_000,
      excludeCredentials: credentials.rows.map((credential) => ({ id: credential.id, transports: credential.transports })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
    const browserToken = newToken(); const pollToken = newToken();
    const created = await db.query<{ id: string }>(
      `INSERT INTO passkey_flows(kind,user_id,challenge,options,credential_name,browser_token_hash,poll_token_hash,expires_at)
       VALUES('register',$1,$2,$3,$4,$5,$6,now()+interval '${FLOW_LIFETIME_MINUTES} minutes') RETURNING id`,
      [user.id, options.challenge, JSON.stringify(options), body.name, hashToken(browserToken), hashToken(pollToken)],
    );
    const flowId = created.rows[0]!.id; const url = new URL(`${config.PASSKEY_PUBLIC_API_URL.replace(/\/$/, "")}/api/v1/auth/passkey/ceremony`);
    url.searchParams.set("flow", flowId); url.hash = `token=${encodeURIComponent(browserToken)}`;
    return { flowId, pollToken, browserUrl: url.toString(), expiresIn: FLOW_LIFETIME_MINUTES * 60 };
  });

  app.get("/auth/passkey/ceremony", async (request, reply) => {
    const query = z.object({ flow: z.string().uuid() }).parse(request.query);
    const exists = await db.query("SELECT 1 FROM passkey_flows WHERE id=$1 AND expires_at>now()", [query.flow]);
    if (!exists.rowCount) throw new AppError(410, "PASSKEY_FLOW_EXPIRED", "認証の有効期限が切れました。アプリからやり直してください。");
    reply.header("Cache-Control", "no-store").header("Referrer-Policy", "no-referrer").header("X-Frame-Options", "DENY")
      .header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
      .type("text/html; charset=utf-8").send(browserPage(query.flow));
  });

  app.post("/auth/passkey/browser/options", async (request) => {
    const body = flowSchema.parse(request.body); const flow = await readFlow(db, body);
    if (flow.attempted_at || flow.completed_at) throw new AppError(409, "PASSKEY_FLOW_USED", "この認証はすでに使用されています。");
    return { kind: flow.kind, options: flow.options };
  });

  app.post("/auth/passkey/browser/complete", async (request) => {
    const body = completionSchema.parse(request.body); const flow = await readFlow(db, body);
    const claimed = await db.query("UPDATE passkey_flows SET attempted_at=now() WHERE id=$1 AND attempted_at IS NULL AND completed_at IS NULL RETURNING id", [flow.id]);
    if (!claimed.rowCount) throw new AppError(409, "PASSKEY_FLOW_USED", "この認証はすでに使用されています。");
    try {
      if (flow.kind === "register") {
        if (!flow.user_id) throw new AppError(400, "PASSKEY_FLOW_INVALID", "登録対象のユーザーがありません。");
        const verification = await verifyRegistrationResponse({ response: body.response as RegistrationResponseJSON, expectedChallenge: flow.challenge, expectedOrigin: config.PASSKEY_ORIGIN, expectedRPID: config.PASSKEY_RP_ID, requireUserVerification: true });
        if (!verification.verified || !verification.registrationInfo) throw new AppError(401, "PASSKEY_VERIFICATION_FAILED", "パスキーを確認できませんでした。");
        const info = verification.registrationInfo; const credential = info.credential;
        await db.query(
          `INSERT INTO passkey_credentials(id,user_id,name,public_key,counter,transports,device_type,backed_up)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [credential.id, flow.user_id, flow.credential_name ?? "マイパスキー", Buffer.from(credential.publicKey), credential.counter, credential.transports ?? [], info.credentialDeviceType, info.credentialBackedUp],
        );
        await db.query("UPDATE passkey_flows SET completed_at=now() WHERE id=$1", [flow.id]);
        await db.query("INSERT INTO activity_logs(actor_id,action,target_type,target_id,metadata) VALUES($1,'auth.passkey.registered','passkey',$2,$3)", [flow.user_id, credential.id, JSON.stringify({ name: flow.credential_name ?? "マイパスキー" })]);
      } else {
        const response = body.response as AuthenticationResponseJSON;
        const credentialResult = await db.query<CredentialRow>(
          `SELECT p.id,p.user_id,p.public_key,p.counter,p.transports,u.username,u.display_name,u.system_role
           FROM passkey_credentials p JOIN users u ON u.id=p.user_id WHERE p.id=$1 AND u.disabled_at IS NULL`, [response.id],
        );
        const credential = credentialResult.rows[0]; if (!credential) throw new AppError(401, "PASSKEY_UNKNOWN", "このパスキーは登録されていません。");
        const verification = await verifyAuthenticationResponse({
          response, expectedChallenge: flow.challenge, expectedOrigin: config.PASSKEY_ORIGIN, expectedRPID: config.PASSKEY_RP_ID, requireUserVerification: true,
          credential: { id: credential.id, publicKey: new Uint8Array(credential.public_key), counter: Number(credential.counter), transports: credential.transports },
        });
        if (!verification.verified) throw new AppError(401, "PASSKEY_VERIFICATION_FAILED", "パスキーを確認できませんでした。");
        await db.query("UPDATE passkey_credentials SET counter=$2,last_used_at=now() WHERE id=$1", [credential.id, verification.authenticationInfo.newCounter]);
        await db.query("UPDATE passkey_flows SET user_id=$2,completed_at=now() WHERE id=$1", [flow.id, credential.user_id]);
        await db.query("INSERT INTO activity_logs(actor_id,action,target_type,target_id) VALUES($1,'auth.passkey.verified','passkey',$2)", [credential.user_id, credential.id]);
      }
      return { verified: true };
    } catch (error) {
      if (error instanceof AppError) throw error;
      request.log.warn({ err: error, flowId: flow.id }, "passkey verification failed");
      throw new AppError(401, "PASSKEY_VERIFICATION_FAILED", "パスキーを確認できませんでした。");
    }
  });

  app.post("/auth/passkey/poll", async (request, reply) => {
    const body = flowSchema.parse(request.body); const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<FlowRow & { username: string | null; display_name: string | null; system_role: "admin" | "user" | null }>(
        `SELECT f.id,f.kind,f.user_id,f.challenge,f.options,f.credential_name,f.attempted_at,f.completed_at,f.consumed_at,u.username,u.display_name,u.system_role
         FROM passkey_flows f LEFT JOIN users u ON u.id=f.user_id
         WHERE f.id=$1 AND f.poll_token_hash=$2 AND f.expires_at>now() FOR UPDATE OF f`, [body.flowId, hashToken(body.token)],
      );
      const flow = result.rows[0]; if (!flow) throw new AppError(410, "PASSKEY_FLOW_EXPIRED", "認証の有効期限が切れました。もう一度お試しください。");
      if (flow.consumed_at) throw new AppError(409, "PASSKEY_FLOW_CONSUMED", "この認証結果はすでに受け取り済みです。");
      if (!flow.completed_at) { await client.query("COMMIT"); return reply.code(202).send({ status: "pending" }); }
      await client.query("UPDATE passkey_flows SET consumed_at=now() WHERE id=$1", [flow.id]);
      if (flow.kind === "register") { await client.query("COMMIT"); return { status: "complete" }; }
      if (!flow.user_id || !flow.username || !flow.display_name || !flow.system_role) throw new AppError(401, "PASSKEY_USER_INVALID", "ユーザーを利用できません。");
      const session = await createSession(app, client, { id: flow.user_id, username: flow.username, system_role: flow.system_role });
      await client.query("COMMIT");
      return { ...session, user: { id: flow.user_id, username: flow.username, displayName: flow.display_name, systemRole: flow.system_role } };
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  });

  app.get("/auth/passkeys", async (request) => {
    const user = await requireUser(request);
    return (await db.query(`SELECT id,name,device_type AS "deviceType",backed_up AS "backedUp",created_at AS "createdAt",last_used_at AS "lastUsedAt" FROM passkey_credentials WHERE user_id=$1 ORDER BY created_at DESC`, [user.sub])).rows;
  });

  app.delete("/auth/passkeys/:id", async (request, reply) => {
    const user = await requireUser(request); const { id } = credentialParams.parse(request.params);
    const deleted = await db.query("DELETE FROM passkey_credentials WHERE id=$1 AND user_id=$2 RETURNING id", [id, user.sub]);
    if (!deleted.rowCount) throw new AppError(404, "PASSKEY_NOT_FOUND", "パスキーが見つかりません。");
    await db.query("INSERT INTO activity_logs(actor_id,action,target_type,target_id) VALUES($1,'auth.passkey.deleted','passkey',$2)", [user.sub, id]);
    reply.code(204).send();
  });
}
