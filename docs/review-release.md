# Review / Release

## Workflow

1. Build画面で編集ツリーからSnapshotを作成する。
2. Review画面でSnapshot、件名、説明を指定して申請する。比較元は明示指定しない場合、直前のSnapshotになる。
3. Owner/Admin/Managerのうち申請者以外が、ファイル差分と必要に応じてテキスト差分を確認する。
4. `承認`または`修正依頼`を行う。修正依頼にはコメントが必須。
5. 修正時は新しいSnapshotを作成し、そのSnapshotで再申請する。前回Snapshotが新しい比較元になる。
6. 承認されたSnapshotをRelease profileでBuildする。
7. Owner/Adminが、承認Reviewと同じSnapshotの成功BuildをVersion付きで公開する。

## Server-side invariants

- Review申請には`review.request`、判定には`review.decide`、公開には`release.publish`が必要。
- 申請者は自分のReviewを承認できない。
- 修正依頼コメントは空にできない。
- Review状態遷移は行ロック下で行い、二重判定を防止する。
- 公開できるのは`profile=release`かつ`succeeded`のBuildだけ。
- ReviewとBuildのSnapshot IDは完全一致が必要。
- Build artifactはDBに記録したsize/SHA-256と再照合する。
- Release artifactは`releases/<project>/<release>.zip`へ複製し、不変の公開物としてBuild artifactから分離する。
- 同じProject Version、または同じBuildの二重公開はDB制約で拒否する。
- Review判定とRelease公開はappend-only `audit_logs`にも記録する。

## Diff limits

Manifest差分は全ファイルを`added / removed / modified / unchanged`へ分類する。テキスト差分は512KiB以下、最大500出力行とし、大入力でAPIメモリや応答を占有しない。PNGなどのバイナリはhash、size、versionの差分を表示する。

## API

- `GET/POST /api/v1/projects/:projectId/reviews`
- `GET /api/v1/projects/:projectId/reviews/:id`
- `GET /api/v1/projects/:projectId/reviews/:id/text-diff?path=...`
- `POST /api/v1/projects/:projectId/reviews/:id/decision`
- `GET/POST /api/v1/projects/:projectId/releases`
- `GET /api/v1/projects/:projectId/releases/:id/artifact`

