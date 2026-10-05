import { useEffect, useState } from "react";
import { LockKeyhole, WifiOff } from "lucide-react";
import type { ProjectFile } from "@mona/shared";
import { ApiError, type StudioApi } from "./api.js";
import { PixelEditor } from "./PixelEditor.js";

export function LockedPixelEditor({ api, projectId, file, blob, canWrite, onSaved }: { api: StudioApi; projectId: string; file: ProjectFile; blob: Blob; canWrite: boolean; onSaved: () => Promise<void> }) {
  const [state, setState] = useState<{ loading: boolean; readOnly: boolean; message: string }>({ loading: canWrite, readOnly: !canWrite, message: canWrite ? "編集Lockを取得しています…" : "このRoleでは閲覧のみ可能です。" });
  useEffect(() => {
    if (!canWrite) return; let disposed = false; let timer = 0; let held: { fileId: string; token: string } | null = null;
    void api.acquireLock(projectId, file.path).then((lock) => { if (disposed) { void api.releaseLock(projectId, lock.fileId, lock.token).catch(() => undefined); return; } held = lock; setState({ loading: false, readOnly: false, message: "編集Lockを取得しました。ほかのユーザーには閲覧専用で表示されます。" }); timer = window.setInterval(() => void api.heartbeatLock(projectId, lock.fileId, lock.token).catch(() => { window.clearInterval(timer); setState({ loading: false, readOnly: true, message: "Lockとの接続が切れたため閲覧専用へ切り替えました。" }); }), 60_000); }).catch((error: unknown) => { const details = error instanceof ApiError ? error.details as { displayName?: string; createdAt?: string } | undefined : undefined; setState({ loading: false, readOnly: true, message: details?.displayName ? `${details.displayName} が編集中です。閲覧専用で開きました。` : error instanceof Error ? error.message : "編集Lockを取得できません。" }); });
    return () => { disposed = true; window.clearInterval(timer); if (held) void api.releaseLock(projectId, held.fileId, held.token).catch(() => undefined); };
  }, [api, projectId, file.path, canWrite]);
  return <div className={`locked-editor ${state.readOnly ? "readonly" : ""}`}><div className={`lock-status ${state.readOnly ? "readonly" : "owned"}`}>{state.readOnly ? <LockKeyhole /> : state.loading ? <WifiOff /> : <LockKeyhole />}<span>{state.message}</span></div><div className="locked-editor-body"><PixelEditor api={api} projectId={projectId} file={file} blob={blob} onSaved={onSaved} readOnly={state.readOnly || state.loading} /></div></div>;
}
