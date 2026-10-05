import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import yauzl from "yauzl";
import { hasPngSignature, IMPORT_LIMITS, isBlockedPackFile, normalizePackPath, validatePackMeta } from "@mona/minecraft-core";
import type { ImportReport, StudioProblem } from "@mona/shared";
import { AppError } from "../errors.js";

export interface ScannedFile { path: string; size: number; sha256: string; mimeType: string | null; }

const MIME: Record<string, string> = { ".json": "application/json", ".mcmeta": "application/json", ".png": "image/png", ".txt": "text/plain", ".md": "text/markdown", ".properties": "text/plain" };
export const mimeFor = (path: string): string | null => MIME[extname(path).toLowerCase()] ?? null;

export class ProjectStorage {
  readonly root: string;
  constructor(dataRoot: string) { this.root = resolve(dataRoot); }
  projectRoot(projectId: string): string { return join(this.root, "projects", projectId, "working"); }
  resolveProjectFile(projectId: string, input: string): string {
    const normalized = normalizePackPath(input);
    const root = this.projectRoot(projectId);
    const target = resolve(root, ...normalized.split("/"));
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw new AppError(400, "UNSAFE_PATH", "安全でないファイルパスです。");
    return target;
  }
  async ensure(): Promise<void> { await mkdir(join(this.root, "projects"), { recursive: true }); await mkdir(join(this.root, "staging"), { recursive: true }); }
  async rollbackInitialImport(projectId: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new AppError(400, "PROJECT_ID_INVALID", "不正なProject IDです。");
    const projectRoot = this.projectRoot(projectId); const projectsRoot = resolve(this.root, "projects");
    if (!resolve(projectRoot).startsWith(`${projectsRoot}${sep}`)) throw new AppError(400, "UNSAFE_PROJECT_ROOT", "安全でないProject pathです。");
    await rm(projectRoot, { recursive: true, force: true }); await mkdir(projectRoot, { recursive: true });
  }
  versionPath(projectId: string, fileId: string, version: number): string {
    if (!/^[0-9a-f-]{36}$/i.test(projectId) || !/^[0-9a-f-]{36}$/i.test(fileId) || !Number.isInteger(version) || version < 1) throw new AppError(400, "VERSION_PATH_INVALID", "不正なVersion pathです。");
    return join(this.root, "projects", projectId, "versions", fileId, String(version));
  }
  async snapshotAndReplace(projectId: string, fileId: string, path: string, currentVersion: number, bytes: Buffer): Promise<{ oldBytes: Buffer; oldVersionKey: string; newVersionKey: string; sha256: string }> {
    const target = this.resolveProjectFile(projectId, path); const oldBytes = await readFile(target); const nextVersion = currentVersion + 1;
    const oldVersionPath = this.versionPath(projectId, fileId, currentVersion); const newVersionPath = this.versionPath(projectId, fileId, nextVersion);
    await mkdir(dirname(oldVersionPath), { recursive: true });
    try { await writeFile(oldVersionPath, oldBytes, { flag: "wx" }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    await writeFile(newVersionPath, bytes, { flag: "wx" });
    const temporary = join(dirname(target), `.${fileId}-${randomUUID()}.tmp`); await writeFile(temporary, bytes, { flag: "wx" });
    try { await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }); throw error; }
    return {
      oldBytes,
      oldVersionKey: relative(this.root, oldVersionPath).split(sep).join("/"),
      newVersionKey: relative(this.root, newVersionPath).split(sep).join("/"),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }
  async restoreWorkingFile(projectId: string, path: string, bytes: Buffer): Promise<void> { await writeFile(this.resolveProjectFile(projectId, path), bytes); }
  async createWorkingFile(projectId: string, path: string, bytes: Buffer): Promise<{ sha256: string }> {
    const target = this.resolveProjectFile(projectId, path); await mkdir(dirname(target), { recursive: true });
    const temporary = join(dirname(target), `.new-${randomUUID()}.tmp`); await writeFile(temporary, bytes, { flag: "wx" });
    try { await rename(temporary, target); } catch (error) { await rm(temporary, { force: true }); throw error; }
    return { sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  async removeWorkingFile(projectId: string, path: string): Promise<Buffer> {
    const target = this.resolveProjectFile(projectId, path); const previous = await readFile(target); await rm(target); return previous;
  }
  async discardWorkingFile(projectId: string, path: string): Promise<void> { await rm(this.resolveProjectFile(projectId, path), { force: true }); }
  async replaceWorkingTree(projectId: string, files: ReadonlyMap<string, Uint8Array>): Promise<{ commit: () => Promise<void>; rollback: () => Promise<void> }> {
    if (!/^[0-9a-f-]{36}$/i.test(projectId)) throw new AppError(400, "PROJECT_ID_INVALID", "不正なProject IDです。");
    await this.ensure(); const projectDir = join(this.root, "projects", projectId); const working = this.projectRoot(projectId);
    const staging = await mkdtemp(join(this.root, "staging", `rollback-${projectId}-`)); const replacement = join(staging, "working"); const backup = join(projectDir, `.working-backup-${randomUUID()}`);
    await mkdir(replacement, { recursive: true });
    try { for (const [path, bytes] of files) { const target = resolve(replacement, ...normalizePackPath(path).split("/")); if (!target.startsWith(`${resolve(replacement)}${sep}`)) throw new AppError(400, "UNSAFE_PATH", "安全でないSnapshot pathです。"); await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: "wx" }); } }
    catch (error) { await rm(staging, { recursive: true, force: true }); throw error; }
    await mkdir(projectDir, { recursive: true });
    try { await rename(working, backup); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") { await rm(staging, { recursive: true, force: true }); throw error; } }
    try { await rename(replacement, working); } catch (error) { try { await rename(backup, working); } catch { /* original root did not exist */ } await rm(staging, { recursive: true, force: true }); throw error; }
    let settled = false;
    return {
      commit: async () => { if (settled) return; settled = true; await rm(backup, { recursive: true, force: true }); await rm(staging, { recursive: true, force: true }); },
      rollback: async () => { if (settled) return; settled = true; await rm(working, { recursive: true, force: true }); try { await rename(backup, working); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } await rm(staging, { recursive: true, force: true }); },
    };
  }
}

function isZipMagic(buffer: Buffer): boolean { return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && ((buffer[2] === 0x03 && buffer[3] === 0x04) || (buffer[2] === 0x05 && buffer[3] === 0x06)); }

function normalizeZipError(error: unknown): Error {
  if (error instanceof Error && /invalid relative path/i.test(error.message)) return new AppError(400, "ZIP_SLIP", "ZIP内に安全でない相対パスがあります。");
  return error instanceof Error ? error : new Error("Invalid ZIP");
}

function openZip(buffer: Buffer): Promise<yauzl.ZipFile> {
  return new Promise((resolveZip, reject) => yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, decodeStrings: true }, (error, zip) => error || !zip ? reject(normalizeZipError(error)) : resolveZip(zip)));
}

async function extractZip(buffer: Buffer, target: string): Promise<string[]> {
  if (buffer.byteLength > IMPORT_LIMITS.zipBytes) throw new AppError(413, "ZIP_TOO_LARGE", "ZIPが100MiBを超えています。");
  if (!isZipMagic(buffer)) throw new AppError(400, "ZIP_SIGNATURE", "ZIPシグネチャを確認できません。");
  const zip = await openZip(buffer);
  const paths: string[] = [];
  const caseFoldedPaths = new Set<string>();
  let fileCount = 0; let expandedBytes = 0;
  return await new Promise<string[]>((resolveExtract, reject) => {
    const fail = (error: unknown) => { zip.close(); reject(normalizeZipError(error)); };
    zip.once("error", fail);
    zip.once("end", () => resolveExtract(paths));
    zip.readEntry();
    zip.on("entry", (entry) => {
      void (async () => {
        const raw = entry.fileName.replaceAll("\\", "/");
        const directory = raw.endsWith("/");
        const candidate = directory ? raw.slice(0, -1) : raw;
        if (!candidate) { zip.readEntry(); return; }
        let safe: string;
        try { safe = normalizePackPath(candidate); } catch { throw new AppError(400, "ZIP_SLIP", `安全でないZIPパスです: ${raw}`); }
        const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (unixMode === 0o120000) throw new AppError(400, "ZIP_SYMLINK", `シンボリックリンクは使用できません: ${safe}`);
        if (directory) { zip.readEntry(); return; }
        if (isBlockedPackFile(safe)) throw new AppError(400, "BLOCKED_FILE", `Resource Packに不要な危険ファイルです: ${safe}`);
        const caseFolded = safe.toLocaleLowerCase("en-US");
        if (caseFoldedPaths.has(caseFolded)) throw new AppError(400, "ZIP_DUPLICATE_PATH", `重複するZIPパスです: ${safe}`);
        caseFoldedPaths.add(caseFolded);
        fileCount += 1; expandedBytes += entry.uncompressedSize;
        if (fileCount > IMPORT_LIMITS.files) throw new AppError(413, "ZIP_FILE_LIMIT", "ZIP内のファイル数が10,000を超えています。");
        if (expandedBytes > IMPORT_LIMITS.expandedBytes) throw new AppError(413, "ZIP_EXPANDED_LIMIT", "ZIP展開後の容量が300MiBを超えています。");
        const output = resolve(target, ...safe.split("/"));
        if (!output.startsWith(`${resolve(target)}${sep}`)) throw new AppError(400, "ZIP_SLIP", `安全でないZIPパスです: ${safe}`);
        await mkdir(dirname(output), { recursive: true });
        await new Promise<void>((resolveEntry, rejectEntry) => zip.openReadStream(entry, async (error, stream) => {
          if (error || !stream) { rejectEntry(error ?? new Error("Cannot read ZIP entry")); return; }
          try {
            const writer = createWriteStream(output, { flags: "wx" });
            stream.once("error", rejectEntry); writer.once("error", rejectEntry); writer.once("finish", resolveEntry);
            stream.pipe(writer);
          } catch (writeError) { rejectEntry(writeError); }
        }));
        paths.push(safe); zip.readEntry();
      })().catch(fail);
    });
  });
}

function detectPackRoot(paths: readonly string[], staging: string): string {
  if (paths.includes("pack.mcmeta")) return staging;
  const candidates = paths.filter((path) => path.endsWith("/pack.mcmeta"));
  if (candidates.length !== 1) throw new AppError(400, "PACK_META_NOT_FOUND", "ZIP直下または単一フォルダ内にpack.mcmetaが必要です。");
  const prefix = candidates[0]!.slice(0, -"pack.mcmeta".length);
  if (!paths.every((path) => path.startsWith(prefix))) throw new AppError(400, "AMBIGUOUS_PACK_ROOT", "Resource Pack外のファイルが混在しています。");
  return resolve(staging, ...prefix.split("/").filter(Boolean));
}

async function walk(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const output: string[] = [];
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new AppError(400, "SYMLINK_NOT_ALLOWED", "シンボリックリンクは使用できません。");
    if (entry.isDirectory()) output.push(...await walk(root, full));
    else if (entry.isFile()) output.push(relative(root, full).split(sep).join("/"));
  }
  return output.sort();
}

export async function scanPack(root: string): Promise<{ report: ImportReport; files: ScannedFile[] }> {
  const paths = await walk(root); const problems: StudioProblem[] = []; const files: ScannedFile[] = [];
  const namespaces = new Set<string>(); let textures = 0; let models = 0; let jsonFiles = 0; let totalBytes = 0;
  if (!paths.includes("pack.mcmeta")) problems.push({ severity: "error", code: "PACK_META_MISSING", message: "pack.mcmetaがありません。", path: "pack.mcmeta" });
  for (const path of paths) {
    const full = resolve(root, ...path.split("/")); const info = await stat(full); const bytes = await readFile(full); const ext = extname(path).toLowerCase();
    totalBytes += info.size;
    if (totalBytes > IMPORT_LIMITS.expandedBytes) throw new AppError(413, "PACK_SIZE_LIMIT", "Resource Packが300MiBを超えています。");
    const namespace = path.match(/^assets\/([^/]+)\//)?.[1]; if (namespace) namespaces.add(namespace);
    if (ext === ".png") { textures += 1; if (!hasPngSignature(bytes.subarray(0, 8))) problems.push({ severity: "error", code: "PNG_SIGNATURE", message: "拡張子はPNGですが内容がPNGではありません。", path }); }
    if (path.includes("/models/") && ext === ".json") models += 1;
    if (ext === ".json" || ext === ".mcmeta") {
      jsonFiles += 1;
      try { const json: unknown = JSON.parse(bytes.toString("utf8")); if (path === "pack.mcmeta") problems.push(...validatePackMeta(json)); }
      catch { problems.push({ severity: "error", code: "JSON_PARSE", message: "JSONを解析できません。", path }); }
    }
    files.push({ path, size: info.size, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: mimeFor(path) });
  }
  return { report: { fileCount: files.length, totalBytes, namespaces: [...namespaces].sort(), textures, models, jsonFiles, problems }, files };
}

export async function importPack(storage: ProjectStorage, projectId: string, buffer: Buffer): Promise<{ report: ImportReport; files: ScannedFile[] }> {
  await storage.ensure();
  const root = storage.projectRoot(projectId);
  await mkdir(root, { recursive: true });
  if ((await readdir(root)).length > 0) throw new AppError(409, "PROJECT_NOT_EMPTY", "Phase 1では空のプロジェクトにのみImportできます。");
  const staging = await mkdtemp(join(storage.root, "staging", "import-"));
  try {
    const paths = await extractZip(buffer, staging);
    const packRoot = detectPackRoot(paths, staging);
    const scanned = await scanPack(packRoot);
    if (scanned.report.problems.some((problem) => problem.severity === "error" && problem.code === "PACK_META_MISSING")) throw new AppError(400, "PACK_INVALID", "有効なResource Packではありません。", scanned.report.problems);
    await cp(packRoot, root, { recursive: true, errorOnExist: true });
    return scanned;
  } finally { await rm(staging, { recursive: true, force: true }); }
}
