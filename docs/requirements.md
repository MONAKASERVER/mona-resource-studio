# 要件定義

## プロダクト境界

Mona Resource Studioは公開Webサイトではなく、Windows向けTauriクライアント、API、PostgreSQL、Redis、MinIO、Build Workerからなる共同編集基盤である。Phase 1は認証、プロジェクト、Import、Explorerを完成させ、編集・レビュー・ビルドを安全に追加できる境界を確定する。

## 機能要件

1. ユーザーは標準ログインし、参加プロジェクトだけを閲覧できる。
2. Owner/Admin/Managerはプロジェクトを作成し、Resource PackのZIPまたはフォルダをImportできる。
3. Import時に元構造を維持し、`pack.mcmeta`、namespace、PNG、JSONを検査する。
4. Explorerはファイル構成とProblemを表示し、画像とテキストをプレビューする。
5. 変更、ロック、コメント、レビュー、ビルド、リリースはプロジェクト単位で監査できる。
6. Variants-CITはProviderとして分離し、未知フィールドを保持して往復編集できる。
7. Minecraftバージョン差分はAdapterに隔離する。

## 非機能要件

- サーバー側認可を必須とし、クライアント表示制御を認可として扱わない。
- パス、ZIP、MIME、JSON、ファイル数、展開後容量を検証する。
- 同時編集は排他ロック、heartbeat、timeout、管理者解除で保護する。
- BuildはWorkerへ隔離し、タイムアウトとログ上限を設ける。
- 重要操作はActivity Logへ追記する。
- UIはダークテーマ、キーボード操作、フォーカス表示、日本語を標準とする。

## Phase 1受け入れ条件

- DBを起動し、seed adminでログインできる。
- プロジェクトを作成し、ZIP/フォルダをImportできる。
- `../`、絶対パス、過大ZIP、危険拡張子を拒否する。
- ExplorerからPNG/JSON/テキストを開ける。
- ViewerはImportできず、Editor以上だけが書き込み操作を行える。
- Core/API/Desktopのビルドとユニットテストが成功する。

