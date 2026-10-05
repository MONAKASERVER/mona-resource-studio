import { randomBytes, randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import type { WebSocket } from "ws";

const EVENTS_CHANNEL = "mona-resource-studio:events";
const PRESENCE_TTL_MS = 60_000;

export interface RealtimeEvent { type: string; projectId: string; at: string; payload: Record<string, unknown>; }
export interface PresenceUser { id: string; username: string; displayName: string; connectedAt: string; }
interface ConnectionInfo extends PresenceUser { projectId: string; connectionId: string; }

export class RealtimeHub {
  private publisher: Redis | null = null; private subscriber: Redis | null = null; private startPromise: Promise<void> | null = null;
  private readonly sockets = new Map<WebSocket, ConnectionInfo>();
  constructor(private readonly redisUrl: string) {}
  private presenceKey(projectId: string) { return `mona-resource-studio:presence:${projectId}`; }
  private presenceDataKey(projectId: string) { return `mona-resource-studio:presence-data:${projectId}`; }
  private async start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      this.publisher = new Redis(this.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true }); this.subscriber = new Redis(this.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
      await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
      this.subscriber.on("message", (_channel, raw) => { try { this.broadcast(JSON.parse(raw) as RealtimeEvent); } catch { /* ignore malformed external event */ } }); await this.subscriber.subscribe(EVENTS_CHANNEL);
    })().catch((error) => { this.startPromise = null; throw error; }); return this.startPromise;
  }
  private broadcast(event: RealtimeEvent): void { const encoded = JSON.stringify(event); for (const [socket, info] of this.sockets) if (info.projectId === event.projectId && socket.readyState === socket.OPEN) socket.send(encoded); }
  async publish(projectId: string, type: string, payload: Record<string, unknown> = {}): Promise<void> { const event: RealtimeEvent = { type, projectId, at: new Date().toISOString(), payload }; try { await this.start(); await this.publisher!.publish(EVENTS_CHANNEL, JSON.stringify(event)); } catch { this.broadcast(event); } }
  async issueTicket(info: Omit<ConnectionInfo, "connectionId">): Promise<string> { await this.start(); const ticket = randomBytes(32).toString("base64url"); await this.publisher!.set(`mona-resource-studio:ws-ticket:${ticket}`, JSON.stringify(info), "EX", 30, "NX"); return ticket; }
  async consumeTicket(ticket: string): Promise<Omit<ConnectionInfo, "connectionId"> | null> { await this.start(); const raw = await this.publisher!.call("GETDEL", `mona-resource-studio:ws-ticket:${ticket}`); return typeof raw === "string" ? JSON.parse(raw) as Omit<ConnectionInfo, "connectionId"> : null; }
  async connect(socket: WebSocket, input: Omit<ConnectionInfo, "connectionId">): Promise<void> {
    await this.start(); const info: ConnectionInfo = { ...input, connectionId: randomUUID() }; this.sockets.set(socket, info); await this.touch(info);
    socket.send(JSON.stringify({ type: "realtime.ready", projectId: info.projectId, at: new Date().toISOString(), payload: { connectionId: info.connectionId } } satisfies RealtimeEvent)); await this.publish(info.projectId, "presence.changed", {});
    socket.on("message", (raw) => { try { const value = JSON.parse(raw.toString()) as { type?: string }; if (value.type === "presence.heartbeat") void this.touch(info); } catch { /* malformed client frames are ignored */ } });
    socket.on("close", () => void this.disconnect(socket)); socket.on("error", () => void this.disconnect(socket));
  }
  private async touch(info: ConnectionInfo): Promise<void> { const expires = Date.now() + PRESENCE_TTL_MS; await this.publisher!.multi().zadd(this.presenceKey(info.projectId), expires, info.connectionId).hset(this.presenceDataKey(info.projectId), info.connectionId, JSON.stringify(info)).pexpire(this.presenceKey(info.projectId), PRESENCE_TTL_MS * 2).pexpire(this.presenceDataKey(info.projectId), PRESENCE_TTL_MS * 2).exec(); }
  private async disconnect(socket: WebSocket): Promise<void> { const info = this.sockets.get(socket); if (!info) return; this.sockets.delete(socket); try { await this.start(); await this.publisher!.multi().zrem(this.presenceKey(info.projectId), info.connectionId).hdel(this.presenceDataKey(info.projectId), info.connectionId).exec(); } catch { /* TTL still clears stale presence */ } await this.publish(info.projectId, "presence.changed", {}); }
  async presence(projectId: string): Promise<PresenceUser[]> {
    await this.start(); const key = this.presenceKey(projectId); const dataKey = this.presenceDataKey(projectId); const now = Date.now(); const stale = await this.publisher!.zrangebyscore(key, 0, now); if (stale.length) await this.publisher!.multi().zrem(key, ...stale).hdel(dataKey, ...stale).exec();
    const active = await this.publisher!.zrangebyscore(key, now + 1, "+inf"); if (!active.length) return []; const records = await this.publisher!.hmget(dataKey, ...active); const users = new Map<string, PresenceUser>();
    for (const raw of records) if (raw) { const entry = JSON.parse(raw) as ConnectionInfo; users.set(entry.id, { id: entry.id, username: entry.username, displayName: entry.displayName, connectedAt: entry.connectedAt }); } return [...users.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, "ja"));
  }
  disconnectUser(projectId: string, userId: string): void { for (const [socket, info] of this.sockets) if (info.projectId === projectId && info.id === userId) socket.close(1008, "Project access removed"); }
  async close(): Promise<void> { for (const socket of this.sockets.keys()) socket.close(1001, "Server shutting down"); await Promise.all([this.publisher?.quit().catch(() => undefined), this.subscriber?.quit().catch(() => undefined)]); }
}
