import { spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BuildProfile } from "@mona/build-core";

const tomlString = (value: string): string => JSON.stringify(value.replaceAll("\\", "/"));

export function packSquashConfig(packRoot: string, outputFile: string, profile: BuildProfile): string {
  return [`pack_directory = ${tomlString(packRoot)}`, `output_file_path = ${tomlString(outputFile)}`, `zip_compression_iterations = ${profile === "release" ? 20 : 1}`, "validate_pack_metadata_file = true", "", "['**/*']", "force_include = true", ""].join("\n");
}

export async function runPackSquash(input: { binary: string; workRoot: string; packRoot: string; outputFile: string; profile: BuildProfile; timeoutMs: number; onLog: (line: string) => void }): Promise<Buffer> {
  const configPath = join(input.workRoot, "packsquash.toml"); await writeFile(configPath, packSquashConfig(input.packRoot, input.outputFile, input.profile), { flag: "wx" });
  await new Promise<void>((resolve, reject) => {
    const child = spawn(input.binary, [configPath], { cwd: input.workRoot, env: { PATH: process.env.PATH ?? "", HOME: input.workRoot, TMPDIR: input.workRoot }, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let settled = false; const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("PackSquash timed out")); }, input.timeoutMs);
    const relay = (prefix: string, chunk: Buffer) => chunk.toString("utf8").split(/\r?\n/).filter(Boolean).forEach((line) => input.onLog(`${prefix}${line}`));
    child.stdout.on("data", (chunk: Buffer) => relay("", chunk)); child.stderr.on("data", (chunk: Buffer) => relay("[stderr] ", chunk));
    child.once("error", (error) => finish(error)); child.once("exit", (code, signal) => code === 0 ? finish() : finish(new Error(`PackSquash exited with ${code ?? signal ?? "unknown"}`)));
  });
  await access(input.outputFile); return readFile(input.outputFile);
}
