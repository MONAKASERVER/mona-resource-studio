import { zipSync } from "fflate";

export async function folderFilesToZip(files: FileList): Promise<File> {
  const entries: Record<string, Uint8Array> = {};
  for (const file of Array.from(files)) {
    const path = file.webkitRelativePath || file.name;
    if (!path || path.includes("\0")) throw new Error("フォルダ内に無効なパスがあります。");
    entries[path.replaceAll("\\", "/")] = new Uint8Array(await file.arrayBuffer());
  }
  const bytes = zipSync(entries, { level: 6 });
  return new File([bytes], "resource-pack-folder.zip", { type: "application/zip" });
}

