# 開発・運用ガイド

## 必要環境

- Node.js 24+
- Rust stable / Tauri 2 prerequisites（Windows WebView2、MSVC Build Tools）
- PostgreSQL 17+
- Docker Compose（任意。ローカルサービス起動用）

## 日常コマンド

```bash
npm install
npm run db:migrate
npm run db:seed
npm run dev
npm run check
npm run tauri:dev
```

API単体は`npm run dev:api`、Web UI単体は`npm run dev:desktop`。`GET /health`はprocess、`GET /ready`はDB接続を検査する。

## 本番注意

JWT secret、DB、MinIO資格情報をsecret managerから渡す。APIとWorkerは別ユーザー/別processにし、working storageとartifact bucketの権限を分ける。HTTPS終端、rate limit、backup、監査ログ保持期間を本番構成で追加する。

