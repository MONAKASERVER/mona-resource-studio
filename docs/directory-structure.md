# ディレクトリ設計

```text
apps/
  desktop/       React + Vite + Tauri 2
  api/           Fastify API / SQL migration / local storage adapter
  worker/        Redis queue consumer / PackSquash adapter (Phase 4)
packages/
  shared/        DTO・権限・Problem
  minecraft/     pack parser・path policy・version adapter
  cit/           provider interface・Variants-CIT
docs/            要件・設計・運用
```

既存のもなか鯖公式サイトとは依存関係を持たせない。既存ツール由来のロジックはテストを伴うTypeScriptとして移植し、ブラウザDOMコードを流用しない。

