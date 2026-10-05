# CIT Provider設計

`CitProvider`は`detect / parse / generate / validate / collectReferences`を提供する。UIはVariants-CIT固有JSONを直接操作せず、`CitDocument`と`CitRule`を介する。

Variants-CIT v5 providerは以下を守る。

- Custom Name、Component、Predicate等をGUI fieldへ変換する。
- 日本語表示名はmapping keyとして保持し、ASCIIのvariant IDと混同しない。
- 既知フィールドだけを編集し、未知フィールドは`unknown`へ保持して再出力する。
- texture/model参照はnamespace付きIDとして正規化し、missing/duplicate/conflictをProblemへ返す。
- generatorは同一入力に対して安定した順序とJSONを生成する。

Minecraft固有出力は`MinecraftVersionAdapter`へ委譲し、pack formatやitem model形式をproviderへ埋め込まない。

## Phase 3 実装

- `component_data`の`custom_name` / `item_name` remap・regex transformをGUI Ruleへ復元する。
- 複数条件は`predicates` moduleへ生成し、Name、Lore、CustomModelData、Enchantment、Damage、任意Componentを扱う。
- 未対応moduleと未知fieldは変更せず保持する。Advanced JSON保存時は楽観的ロックとJSON Object検証を行う。
- 同一条件、部分一致、missing reference、参照pathの大文字小文字不一致をProblemsへ出す。
- GUI保存はResource Pack内の実JSONと`cit_entries`のnormalized metadataを同一DB transactionで更新する。
