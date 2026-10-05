import type { SnapshotManifest } from "@mona/build-core";

export type DiffStatus = "added" | "removed" | "modified" | "unchanged";
export interface ManifestDiffEntry {
  path: string;
  status: DiffStatus;
  before: { sha256: string; size: number; version: number } | null;
  after: { sha256: string; size: number; version: number } | null;
}

export function diffManifests(base: SnapshotManifest | null, current: SnapshotManifest): ManifestDiffEntry[] {
  const before = new Map((base?.files ?? []).map((file) => [file.path, file]));
  const after = new Map(current.files.map((file) => [file.path, file]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return paths.map((path) => {
    const left = before.get(path); const right = after.get(path);
    const status: DiffStatus = !left ? "added" : !right ? "removed" : left.sha256 === right.sha256 ? "unchanged" : "modified";
    return { path, status, before: left ? { sha256: left.sha256, size: left.size, version: left.version } : null, after: right ? { sha256: right.sha256, size: right.size, version: right.version } : null };
  });
}

export interface TextDiffLine { kind: "context" | "add" | "remove"; text: string; beforeLine: number | null; afterLine: number | null; }
export function diffText(beforeText: string, afterText: string, maxLines = 500): { lines: TextDiffLine[]; truncated: boolean } {
  const before = beforeText.replaceAll("\r\n", "\n").split("\n"); const after = afterText.replaceAll("\r\n", "\n").split("\n");
  let prefix = 0; while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0; while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  const output: TextDiffLine[] = [];
  const push = (line: TextDiffLine) => { if (output.length < maxLines) output.push(line); };
  for (let index = Math.max(0, prefix - 3); index < prefix; index += 1) push({ kind: "context", text: before[index]!, beforeLine: index + 1, afterLine: index + 1 });
  for (let index = prefix; index < before.length - suffix; index += 1) push({ kind: "remove", text: before[index]!, beforeLine: index + 1, afterLine: null });
  for (let index = prefix; index < after.length - suffix; index += 1) push({ kind: "add", text: after[index]!, beforeLine: null, afterLine: index + 1 });
  for (let offset = 0; offset < Math.min(3, suffix); offset += 1) { const bi = before.length - suffix + offset; const ai = after.length - suffix + offset; push({ kind: "context", text: before[bi]!, beforeLine: bi + 1, afterLine: ai + 1 }); }
  const expected = Math.min(3, prefix) + (before.length - prefix - suffix) + (after.length - prefix - suffix) + Math.min(3, suffix);
  return { lines: output, truncated: output.length < expected };
}

export function releaseEligibility(input: { buildStatus: string; buildProfile: string; buildSnapshotId: string; artifactKey: string | null; reviewStatus: string; reviewSnapshotId: string }): string[] {
  const errors: string[] = [];
  if (input.buildStatus !== "succeeded" || !input.artifactKey) errors.push("BUILD_NOT_READY");
  if (input.buildProfile !== "release") errors.push("RELEASE_PROFILE_REQUIRED");
  if (input.reviewStatus !== "approved") errors.push("REVIEW_NOT_APPROVED");
  if (input.buildSnapshotId !== input.reviewSnapshotId) errors.push("SNAPSHOT_MISMATCH");
  return errors;
}
