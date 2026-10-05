import { useEffect, useState } from "react";
import { Download, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent } from "@tauri-apps/plugin-updater";

type UpdateState =
  | { phase: "hidden" }
  | { phase: "checking" }
  | { phase: "downloading"; version: string; downloaded: number; total?: number | undefined }
  | { phase: "installing"; version: string }
  | { phase: "error"; message: string };

export function AutoUpdater() {
  const [state, setState] = useState<UpdateState>({ phase: "hidden" });

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let active = true; let running = false; let errorTimer = 0;
    const run = async () => {
      if (!active || running) return; running = true;
      if (active) setState({ phase: "checking" });
      try {
        const update = await check({ timeout: 30_000 });
        if (!update || !active) { if (active) setState({ phase: "hidden" }); return; }
        let downloaded = 0; let total: number | undefined;
        const onProgress = (event: DownloadEvent) => {
          if (!active) return;
          if (event.event === "Started") total = event.data.contentLength;
          if (event.event === "Progress") downloaded += event.data.chunkLength;
          setState(event.event === "Finished" ? { phase: "installing", version: update.version } : { phase: "downloading", version: update.version, downloaded, total });
        };
        await update.downloadAndInstall(onProgress, { timeout: 5 * 60_000, restartAfterInstall: true });
        if (active) { setState({ phase: "installing", version: update.version }); await relaunch(); }
      } catch (error: unknown) {
        if (!active) return;
        setState({ phase: "error", message: error instanceof Error ? error.message : "更新を適用できませんでした。" });
        errorTimer = window.setTimeout(() => active && setState({ phase: "hidden" }), 10_000);
      } finally { running = false; }
    };
    const timer = window.setTimeout(() => void run(), 1_500);
    const interval = window.setInterval(() => void run(), 60 * 60_000);
    return () => { active = false; window.clearTimeout(timer); window.clearInterval(interval); window.clearTimeout(errorTimer); };
  }, []);

  if (state.phase === "hidden" || state.phase === "checking") return null;
  const percent = state.phase === "downloading" && state.total ? Math.min(100, Math.round(state.downloaded / state.total * 100)) : undefined;
  return <aside className={`auto-update ${state.phase === "error" ? "error" : ""}`} role="status" aria-live="polite">
    <div className="auto-update-icon">{state.phase === "error" ? <TriangleAlert /> : state.phase === "installing" ? <RefreshCw className="spin" /> : <Download />}</div>
    <div><strong>{state.phase === "error" ? "自動更新に失敗しました" : state.phase === "installing" ? `v${state.version}を適用しています` : `v${state.version}をダウンロード中`}</strong><span>{state.phase === "error" ? state.message : state.phase === "installing" ? "完了後にアプリを再起動します。" : percent === undefined ? "更新ファイルを取得しています…" : `${percent}%`}</span>{state.phase === "downloading" && <div className="auto-update-progress"><i style={{ width: `${percent ?? 8}%` }} /></div>}</div>
    {state.phase !== "error" && <ShieldCheck className="auto-update-secure" />}
  </aside>;
}
