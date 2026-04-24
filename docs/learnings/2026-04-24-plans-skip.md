# dev-flow から `superpowers:writing-plans` を外した理由

- **Date**: 2026-04-24
- **Context**: 最初の大規模タスク (core todo parser) を回した直後、`docs/superpowers/plans/2026-04-24-core-parser.md` の役割が ADR-0001 + 会話ログとほぼ重複していた。

## 結論

- 中・大規模のスキルチェーンから `superpowers:writing-plans` を外し、代わりに「設計概要をユーザーに提示して合意」を挟む
- `docs/superpowers/plans/` ディレクトリは削除
- `superpowers:writing-plans` は **subagent 並列駆動 / セッションを跨ぐ長期作業 / 第三者への手渡し** のいずれかに該当するときだけ手動で起動する

## なぜ

**ADR と plans の役割は本来違う**:

- ADR = *決定* の凍結（なぜ A を選んだか、二度と蒸し返さないため）
- plans = *実行手順* の詳細（TDD チェックリスト・ファイル別の作業ブレークダウン）

別物なので **plans は存在意義がある**。ただしそれは、**実行者がコンテキストを持たない**前提のとき。具体的には:

- subagent にディスパッチして並列実装する
- 明日の自分 / 他人が plans を読んで続きを進める
- 会話ログが圧縮・消失した後も作業を再現したい

task_viewer の現状はどれにも該当しない:

- 1セッション内で dev-flow → 合意 → TDD → code-review を完走する
- 実装は in-context の対話で進む（メインエージェントが全コンテキストを保持）
- 設計の凍結は ADR に集約されている

この条件下では plans は **書いた瞬間に会話ログの重複**になり、更新されず、次のタスクでは読まれない。2026-04-24-core-parser.md はまさにそのパターンだった。

## トレードオフ（受け入れるコスト）

- セッション途中で clear / コンテキスト溢れが起きると、中断復帰の手がかりが ADR + todo list だけになる
- subagent 並列化したくなったときは個別に `writing-plans` を起動する一手間が生じる
- 「plans ファイルがある = 進行中タスクがある」という視覚的マーカーが使えなくなる（代替: TodoWrite の in_progress 状態）

## 再発防止

- dev-flow SKILL.md は常にこの learning を指すようにする
- もし**再び plans を書きたくなった**ら、その理由が上記3条件のどれかに該当するか先に自問する
- 該当しないなら、書かずに ADR と会話で済ませる

## 関連

- `/Users/tahara_kazuki/products/task_viewer/.claude/skills/dev-flow/SKILL.md`
- `/Users/tahara_kazuki/products/task_viewer/docs/adr/0001-monorepo-layout-and-responsibility-separation.md`
