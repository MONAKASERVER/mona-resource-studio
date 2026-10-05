# Build / Release Pipeline

1. APIが編集中treeからimmutable snapshotを作る。
2. Build Jobへsnapshot ID、Minecraft version、PackSquash profile、requesterを記録する。
3. Workerが専用作業ディレクトリへ展開し、preflight validatorを実行する。
4. PackSquashを制限付きprocessとして実行する。
5. stdout/stderrを構造化し、失敗箇所を可能な範囲でsource pathへ対応付ける。
6. 成功artifactをMinIOへ置き、SHA-256、size、tool versionをDBへ保存する。
7. Release承認後だけ正式artifactとして配布可能にする。

## 実装済みの安全境界

- APIはDBに記録されたsize/SHA-256とWorking Storageの実体を照合してからSnapshotを確定する。
- Snapshot ZIP、Worker log、Build artifactはMinIOへ分離して保存する。
- BullMQ job IDにはDBのBuild IDを使用し、同一Buildの重複投入を防ぐ。
- WorkerはBuildごとの一時ディレクトリへ展開し、Snapshot manifest、`pack.mcmeta`、JSONを再検証する。
- PackSquashはshellを介さず固定引数・限定環境変数・profile別timeoutで起動する。
- Developmentは圧縮iteration 1、Releaseは20。未知のmod固有ファイルも`force_include`する。
- 成功時だけartifact key、SHA-256、sizeをDBへ確定する。失敗時もerror codeと最大2MBのlogを残す。
- RollbackはSnapshotの全ファイルを再検証し、stagingで作業ツリーを原子的に交換する。DB失敗時は元ツリーへ戻す。
- Build中のRollbackは禁止する。

Phase 6で承認済みSnapshotと一致するRelease Buildだけを、不変Release artifactとして公開するworkflowを追加した。詳細は`review-release.md`を参照。
