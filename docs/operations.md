# Operations / Failure Recovery

## Release前チェック

```bash
npm ci
npm run check
npm run db:migrate
docker compose config
```

開発Composeでは標準S3 API互換のLocalStack S3を公開digest固定で使用する。本番はMinIO、AWS S3など任意のS3互換Object Storageを使用できる。Object Storage製品を変更するときはSnapshot作成、Release copy、SHA-256照合、削除補償処理をstagingで再検証する。

API起動後、`npm run test:integration:review-release`で実PostgreSQL・Redis・S3を通したReview/Releaseの統合確認を行う。この検証は専用Projectと`phase6_reviewer`を開発DBに作成するため、本番環境では実行しない。

Migration前にPostgreSQL、Object Storage bucket、`studio-data`を同じ復旧点としてBackupする。Migrationは追加列・追加table中心で既存データと後方互換だが、先にstagingで実行する。

## Backup

- PostgreSQL: 日次full backupと継続WAL。`snapshots`、`review_requests`、`review_events`、`build_jobs`、`releases`、`audit_logs`を含める。
- Object Storage: bucket versioningまたは別bucketへのreplication。特に`snapshots/`と`releases/`を保持する。
- Working files: `studio-data` volumeをSnapshot。ただし正式復旧点はDBとObject Storageを同時刻にそろえる。
- Redis: Queue/Presence用途でありsource of truthにしない。Redis喪失時はDBの`queued/running` Buildを監査して再投入またはfailedへ確定する。

## Recovery order

1. APIとWorkerへの新規流入を止める。
2. PostgreSQLを復旧する。
3. Object Storageを同じ復旧点へ戻し、Release/Snapshot keyの存在とSHA-256を照合する。
4. Working volumeを復旧する。必要なら最後のSnapshotからRollbackする。
5. Redisを空で起動する。
6. `npm run db:migrate`を実行する。
7. API、Workerの順に起動し、`/health`、`/ready`、Development Buildで確認する。
8. Review承認とReleaseの照合をpreviewし、書き込みを再開する。

## Failure matrix

| Failure | Expected behavior | Operator action |
|---|---|---|
| Redis停止 | Build投入は`QUEUE_UNAVAILABLE`、DB jobはfailed。編集・Reviewは継続 | Redis復旧後に新規Build |
| Worker停止 | Buildはqueuedのまま、Release不可 | Worker復旧。BullMQがjobを配送 |
| Object Storage停止 | Snapshot/Release作成が失敗。DBへ不完全なReleaseを残さない | Object Storage復旧、再実行 |
| PostgreSQL停止 | `/ready`失敗、更新API失敗 | DB復旧後に整合性確認 |
| Artifact改ざん/欠落 | Release公開またはDLがhash mismatch/404で停止 | Backupから対象keyを復元 |
| APIがartifact copy後・DB commit前に停止 | Release DB行なし、孤立objectの可能性 | `releases/`をDBと突合して孤立keyを隔離 |
| 同時承認 | `FOR UPDATE`により先行判定のみ成功 | Activity/Audit Logを確認 |
| 同Version同時公開 | UNIQUE制約により片方だけ成功 | 成功Releaseを採用 |

## Load / abuse checks

- Manifest差分はpath数に対して線形、テキスト差分も線形で最大500行に制限。
- text diff入力は片側512KiBまで。API bodyは2MiB、Importは別途100MiB制限。
- `services/reviews.test.ts`は20,000行同士の敵対的大入力でも100行capを検証する。
- 本番相当の負荷試験では、同一Projectに対するReview list/detailを段階的に増やし、p95、DB pool待ち、Object Storage read latencyを監視する。Release publishは破壊的な公開操作なのでread負荷試験と分離する。

## Audit maintenance

`audit_logs`はtriggerにより通常のUPDATE/DELETEを拒否する。法的・運用上の削除が必要な緊急保守だけ、専用transactionで`SET LOCAL mona.audit_maintenance = 'on'`を設定し、作業者・理由・対象範囲を外部監査記録へ残す。
