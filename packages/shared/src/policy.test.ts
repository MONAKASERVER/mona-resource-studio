import { describe, expect, it } from "vitest";
import { hasPermission } from "./index.js";

describe("project RBAC", () => {
  it("keeps viewers read-only", () => {
    expect(hasPermission("viewer", "file.read")).toBe(true);
    expect(hasPermission("viewer", "project.import")).toBe(false);
    expect(hasPermission("viewer", "release.publish")).toBe(false);
    expect(hasPermission("viewer", "comment.write")).toBe(true);
  });

  it("lets editors import but not publish", () => {
    expect(hasPermission("editor", "project.import")).toBe(true);
    expect(hasPermission("editor", "release.publish")).toBe(false);
  });
});
