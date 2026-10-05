# Collaboration

## Realtime

1. Clientが認証済みREST APIから30秒有効・一回限りのRealtime ticketを取得する。
2. `ws(s)://.../projects/:projectId/realtime?ticket=...` へ接続する。
3. Clientは25秒ごとに`presence.heartbeat`を送る。
4. API instance間のevent fan-outにはRedis Pub/Subを使用する。
5. Presenceは60秒で失効し、切断通知を取りこぼしても自動回収される。

## Soft Lock

- PNG Editorを開くと自動取得する。
- TTLは5分、Client heartbeatは60秒。
- 別ユーザーが保持中ならEditorは閲覧専用になる。
- 保存APIも別ユーザーのLockを検査し、HTTP 423で拒否する。
- Owner/Admin/ManagerはCollaboration画面から強制解除でき、Activity Logへ記録される。
- Lock tokenは平文保存せずSHA-256 hashのみDBへ保存する。

## Comments / Notifications

- FileまたはLogical Itemのどちらか一方へコメントを作成する。
- コメント作成時は投稿者以外のProjectメンバーへ永続通知を作成する。
- 投稿者、Owner、Admin、Managerがコメントを解決できる。
- Member変更、コメント、強制Lock解除などの重要操作はActivity Logへ残す。
