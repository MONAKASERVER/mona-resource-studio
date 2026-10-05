import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { zipSync, unzipSync } from "fflate";
import { Client } from "minio";
import { normalizePackPath } from "@mona/minecraft-core";

export const BUILD_QUEUE_NAME = "mona-resource-builds";

export type BuildProfile = "development" | "release";
export interface BuildJobPayload { buildId: string; projectId: string; snapshotId: string; profile: BuildProfile; }
export interface SnapshotFile { path: string; size: number; sha256: string; mimeType: string | null; version: number; }
export interface SnapshotManifest { schemaVersion: 1; projectId: string; minecraftVersion: string; createdAt: string; files: SnapshotFile[]; }

export function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }

export function encodePackArchive(files: ReadonlyMap<string, Uint8Array>): Buffer {
  const input: Record<string, Uint8Array> = {};
  for (const path of [...files.keys()].sort()) input[normalizePackPath(path)] = files.get(path)!;
  return Buffer.from(zipSync(input, { level: 6 }));
}

export function decodePackArchive(bytes: Uint8Array): Map<string, Buffer> {
  const decoded = unzipSync(bytes); const output = new Map<string, Buffer>(); const folded = new Set<string>();
  for (const [rawPath, content] of Object.entries(decoded)) {
    const path = normalizePackPath(rawPath); const key = path.toLocaleLowerCase("en-US");
    if (folded.has(key)) throw new Error(`Archive contains a duplicate path: ${path}`);
    folded.add(key); output.set(path, Buffer.from(content));
  }
  return output;
}

export async function materializePack(files: ReadonlyMap<string, Uint8Array>, root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  for (const [rawPath, bytes] of files) {
    const path = normalizePackPath(rawPath); const target = resolve(resolvedRoot, ...path.split("/"));
    if (!target.startsWith(`${resolvedRoot}${sep}`)) throw new Error(`Unsafe archive path: ${path}`);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: "wx" });
  }
}

export interface ObjectStoreConfig { endpoint: string; accessKey: string; secretKey: string; bucket: string; }

export class ObjectStore {
  private readonly client: Client;
  constructor(private readonly config: ObjectStoreConfig) {
    const endpoint = new URL(config.endpoint);
    this.client = new Client({ endPoint: endpoint.hostname, port: endpoint.port ? Number(endpoint.port) : endpoint.protocol === "https:" ? 443 : 80, useSSL: endpoint.protocol === "https:", accessKey: config.accessKey, secretKey: config.secretKey });
  }
  private key(input: string): string {
    const key = input.replaceAll("\\", "/").replace(/^\/+/, "");
    if (!key || key.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Unsafe object key");
    return key;
  }
  async ensureBucket(): Promise<void> { if (!await this.client.bucketExists(this.config.bucket)) try { await this.client.makeBucket(this.config.bucket); } catch (error) { if (!/BucketAlready(?:OwnedByYou|Exists)/.test(String((error as { code?: string }).code ?? error))) throw error; } }
  async put(key: string, bytes: Buffer, contentType = "application/octet-stream"): Promise<void> { await this.ensureBucket(); await this.client.putObject(this.config.bucket, this.key(key), bytes, bytes.length, { "Content-Type": contentType }); }
  async get(key: string): Promise<Buffer> {
    const stream = await this.client.getObject(this.config.bucket, this.key(key)); const chunks: Buffer[] = [];
    for await (const chunk of stream as Readable) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  async remove(key: string): Promise<void> { await this.client.removeObject(this.config.bucket, this.key(key)); }
}
