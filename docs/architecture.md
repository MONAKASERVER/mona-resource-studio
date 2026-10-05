# アーキテクチャ

```text
Tauri 2 / React Desktop
        │ HTTPS + JWT
        ▼
Fastify API ───── PostgreSQL (metadata, auth, audit, workflow)
    │   │
    │   ├──────── Redis (presence, queue, realtime fan-out)
    │   └──────── MinIO (snapshot/release artifacts)
    ▼
Project Working Storage (authoritative editable tree)
        │ immutable job input
        ▼
Build Worker ─ PackSquash ─ artifact + log + release metadata
```

## 責務

- `apps/desktop`: ログイン、Dashboard、IDE shell、ファイル取込/表示。権限判断は表示補助のみ。
- `apps/api`: 認証、RBAC、プロジェクト、ファイル、ロック、レビュー、監査、ジョブ投入。
- `apps/worker`: ビルド専用プロセス。APIプロセス内でPackSquashを実行しない。
- `packages/shared`: API DTO、Role/Permission、Problem型。
- `packages/minecraft-core`: パス、Resource Pack解析、Version Adapter。
- `packages/cit-core`: CIT Provider契約、Variants-CIT parse/generate/validate。
- `packages/build-core`: Snapshot ZIP、object storage、Build Queue DTO、SHA-256検証。

## 整合性方針

編集対象の実体はProject Working Storage、検索/権限/履歴はPostgreSQLを正とする。DBとファイルを跨ぐ操作はstagingへ先に書き、検査成功後にProjectへ配置してDBへ記録する。失敗したstagingは参照されず、定期回収対象となる。Buildは開始時Snapshotを固定し、その後の編集から隔離する。

## 同時編集

WebSocket/Redis Pub/Subでpresence、lock、comment、item/file変更、build statusを配信する。WebSocket接続にはREST認証後に発行する30秒・一回限りのticketを使い、Access TokenをURLへ出さない。編集権はサーバー発行のfile lockで決め、lockは所有者、token hash、5分期限、heartbeatを持つ。別ユーザーの有効lockがあるファイルはAPIでも書込みを拒否し、manager以上は強制解除できる。

Presenceは接続単位でRedis sorted setへ60秒TTLを記録し、複数端末・複数API instanceを集約してユーザー単位で表示する。WebSocketが利用できない場合もUIは30秒ごとにRESTから再同期する。
