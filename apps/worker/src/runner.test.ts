import { describe, expect, it } from "vitest";
import { packSquashConfig } from "./runner.js";

describe("PackSquash runner", () => {
  it("creates a constrained development profile", () => { const value = packSquashConfig("C:\\pack", "C:\\out.zip", "development"); expect(value).toContain('pack_directory = "C:/pack"'); expect(value).toContain("zip_compression_iterations = 1"); });
  it("uses stronger compression for release builds", () => { expect(packSquashConfig("/pack", "/out.zip", "release")).toContain("zip_compression_iterations = 20"); });
});
