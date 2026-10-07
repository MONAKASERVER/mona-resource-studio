# Mona Resource Studio

Minecraft Java Edition向けリソースパックをチームで編集・レビュー・ビルドするための、Tauri 2デスクトップクライアントとサーバー型バックエンドです。

## ダウンロード

Windows版インストーラー（`.exe`）は [GitHub Releases](https://github.com/MONAKASERVER/mona-resource-studio/releases/latest) からダウンロードできます。配布版の既定接続先は `https://www.monacraft.net/studio-api` です。

更新内容は[パッチノート](パッチノート.md)で確認できます。

デスクトップアプリはMona Resource Studio APIへ接続して使用します。サーバーを自分で構築する場合は、下記の「起動」と `docs/` 内の手順を参照してください。公開バイナリは現時点ではコード署名されていないため、Windows SmartScreenの確認画面が表示される場合があります。

## 実装済みの機能

- ユーザー名/パスワード認証（Argon2id、短命Access Token、ローテーションRefresh Token）
- Windows Hello・スマートフォン・セキュリティキー対応のパスキーログイン／登録管理
- プロジェクト作成・一覧・RBAC
- ZIPまたはフォルダからのResource Pack Import
- Zip Slip、容量、ファイル数、拡張子偽装、危険ファイルの検査
- `pack.mcmeta` / namespace / texture / model / JSON の解析
- IDE風Explorerとテキスト/画像プレビュー
- 16/32/64px PNGエディター（ペン、消しゴム、塗りつぶし、直線、スポイト、範囲選択）
- レイヤー、透明度、左右/上下ミラー、回転、Undo/Redo、ズーム、グリッド
- ローカル下書きと、楽観的ロックによる競合検知付きファイル保存
- ファイルの不変バージョン履歴とサーバー側ロールバック基盤
- Logical Item / Categoryの作成・編集・削除・検索
- Variants-CIT v5 GUI Editor（日本語名、複数条件、参照、Preview）
- 既存CIT JSONの解析・未知フィールド保持・Advanced JSON編集
- CIT競合、missing reference、大文字小文字不一致の検出
- Minecraft 1.21系Give Command生成とVersion Adapter
- Immutable Snapshot作成・SHA-256整合性検証・Snapshot Rollback
- Redis Build Queue、隔離Build Worker、PackSquash Development/Release profile
- Build進捗・ログ・成果物履歴とZIPダウンロード
- S3互換Object StorageへのSnapshot、Build log、Artifact保存
- WebSocket + Redis Pub/SubによるRealtime EventとOnline Presence
- 5分TTL・Heartbeat付きSoft Lock、閲覧専用切替、管理者強制解除
- ファイル／Logical Itemコメント、Activity Timeline、アプリ内通知
- Projectメンバー追加・Role変更・削除
- Snapshot単位のReview申請、自己承認禁止、コメント必須の修正依頼、再申請
- Manifest／テキスト差分、Review Event履歴、Realtime通知
- 承認Snapshot一致・Release profile・SHA-256再検証付きの不変Release公開
- append-only Audit Log、運用・Backup・障害復旧Runbook
- PostgreSQL永続化、Docker Compose開発環境

## 起動

```bash
cp .env.example .env
docker compose up -d postgres redis minio
npm install
npm run db:migrate
npm run db:seed
npm run dev
# 別ターミナル（ローカルにPackSquashが必要）
npm run dev:worker
```

デスクトップUIは `http://localhost:1420`、APIは `http://localhost:4100` です。ネイティブウィンドウは `npm run tauri:dev` で起動します。

APIとPackSquash同梱Workerをコンテナで起動する場合は `docker compose up --build` を使用します。

Review/Releaseの実DB・実S3統合確認は、APIを起動した状態で次を実行します。検証用ProjectとReviewerが開発DBに作成されます。

```bash
npm run test:integration:review-release
```

初期認証情報は `.env` の `SEED_ADMIN_*` を使用します。初回ログイン後に変更し、本番では開発用既定Secretを使用しないでください。

詳細は [docs/architecture.md](docs/architecture.md)、[docs/development.md](docs/development.md)、[docs/review-release.md](docs/review-release.md)、[docs/operations.md](docs/operations.md) を参照してください。

KAGOYA VPSの本番構成は [docs/vps-deployment.md](docs/vps-deployment.md) を参照してください。
