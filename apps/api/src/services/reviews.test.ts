import { describe, expect, it } from "vitest";
import type { SnapshotManifest } from "@mona/build-core";
import { diffManifests, diffText, releaseEligibility } from "./reviews.js";

const manifest = (files: Array<[string, string, number]>): SnapshotManifest => ({ schemaVersion: 1, projectId: "p", minecraftVersion: "1.21.11", createdAt: "2026-10-05T00:00:00Z", files: files.map(([path, sha256, size], index) => ({ path, sha256, size, version: index + 1, mimeType: "text/plain" })) });

describe("review diff", () => {
  it("classifies added, removed, modified and unchanged files", () => {
    const result = diffManifests(manifest([["same.txt", "a", 1], ["old.txt", "b", 2], ["change.txt", "c", 3]]), manifest([["same.txt", "a", 1], ["new.txt", "d", 4], ["change.txt", "e", 5]]));
    expect(Object.fromEntries(result.map((entry) => [entry.path, entry.status]))).toEqual({ "change.txt": "modified", "new.txt": "added", "old.txt": "removed", "same.txt": "unchanged" });
  });
  it("caps text output under hostile large input", () => { const result = diffText("a\n".repeat(20_000), "b\n".repeat(20_000), 100); expect(result.lines).toHaveLength(100); expect(result.truncated).toBe(true); });
});

describe("release gate", () => {
  it("accepts only successful release builds of the approved snapshot", () => { expect(releaseEligibility({ buildStatus: "succeeded", buildProfile: "release", buildSnapshotId: "s", artifactKey: "a", reviewStatus: "approved", reviewSnapshotId: "s" })).toEqual([]); });
  it("reports every violated invariant", () => { expect(releaseEligibility({ buildStatus: "running", buildProfile: "development", buildSnapshotId: "a", artifactKey: null, reviewStatus: "open", reviewSnapshotId: "b" })).toEqual(["BUILD_NOT_READY", "RELEASE_PROFILE_REQUIRED", "REVIEW_NOT_APPROVED", "SNAPSHOT_MISMATCH"]); });
});
