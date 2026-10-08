# DB・API・ファイルモデル

## アカウント

- `GET /api/v1/auth/me`: 現在のアカウント情報を取得
- `PATCH /api/v1/auth/profile`: 固定ニックネーム（表示名）を更新
- `POST /api/v1/auth/password`: 現在のパスワードを確認して変更し、既存セッションを失効
- `GET/DELETE /api/v1/auth/passkeys`: 登録済みパスキーの確認・削除

## 主要テーブル

- users / refresh_tokens
- projects / project_members
- project_files / file_versions / file_locks
- logical_items / categories / cit_entries
- comments / review_requests / review_events
- snapshots / build_jobs / releases
- activity_logs

全主キーはUUID、日時は`TIMESTAMPTZ`、金額やハッシュのように精度が必要な値は適切な型を使う。ファイル内容をDBへ直接格納せず、hashとstorage keyを保持する。

## API v1

- `POST /api/v1/auth/login|refresh|logout`, `GET /api/v1/auth/me`
- `GET|POST /api/v1/projects`, `GET /api/v1/projects/:projectId`
- `POST /api/v1/projects/:projectId/import`
- `GET /api/v1/projects/:projectId/files`
- `GET /api/v1/projects/:projectId/files/content?path=...`
- `POST /api/v1/projects/:projectId/files/save`（PNG、`baseVersion`による競合検知）
- `GET|POST /api/v1/projects/:projectId/categories`
- `DELETE /api/v1/projects/:projectId/categories/:categoryId`
- `GET|POST /api/v1/projects/:projectId/items`
- `PATCH|DELETE /api/v1/projects/:projectId/items/:itemId`
- `GET|PUT /api/v1/projects/:projectId/cit`（解析、検証、安定生成、複数JSONの楽観的ロック保存）
- `PUT /api/v1/projects/:projectId/cit/raw`（Advanced JSON編集）
- 将来: locks, comments, reviews, snapshots, builds, releases, activity

JSONエラーは `{ error: { code, message, details? } }` に統一する。破壊的操作と管理操作はidempotency keyを受け付け、監査ログへactor、project、IP、user-agent、対象を記録する。

## Project Working Storage

```text
projects/{projectUuid}/working/
  pack.mcmeta
  pack.png
  assets/{namespace}/...
staging/{randomUuid}/...
versions/{projectUuid}/{fileUuid}/{version}/...
```

ユーザー入力パスは常にPOSIX相対パスへ正規化し、absolute、drive letter、NUL、`..`を拒否する。解決後の絶対パスがproject root配下であることを再確認する。

PNG・CIT JSON保存時は対象行を`SELECT ... FOR UPDATE`でロックし、クライアントの`baseVersion`と現在版が一致した場合だけ更新する。旧版と新版は不変ファイルとして`versions/`へ保存し、DB更新失敗時はworking fileを復元する。CITの複数ファイル保存はDB transaction内で処理し、新規・更新・削除のfilesystem変更も失敗時に復元する。
