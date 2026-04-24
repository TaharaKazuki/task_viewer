---
name: code-review
description: Use as the final gate after implementation is complete in this repo. Runs verification (test/lint/build with real command output), project-specific checklist, adversary review via subagent, and extracts learnings to docs/learnings/. Do NOT declare a task done without going through this.
---

# code-review — 実装後の検証ゲート

dev-flow のチェーン終端。**通ったはず・問題ないはず で絶対に終わらせない**。

## 4段階の検証

### 1. 証拠つき検証

以下を実際に実行し、出力を目で見る。「通った」と思い込まない。

- `pnpm -r typecheck`（あれば）
- `pnpm -r test`（あれば）
- `pnpm -r lint`（あれば）
- `pnpm -r build`（あれば）

まだ package.json が無いフェーズでは、変更したファイルが構文的に壊れていないかを `node --check` 等で個別に確認する。

汎用ロジックは `superpowers:verification-before-completion` に委譲してよい。プロジェクト固有の実行方法だけここで指定する。

### 2. プロジェクト固有チェックリスト

- [ ] `CLAUDE.md` を書き換えていない
- [ ] 新しい設計判断をしたなら `docs/adr/NNNN-*.md` を起票した
- [ ] `packages/core` に UI/サーバ依存のコードを混ぜていない
- [ ] 監視ループや SSE エンドポイントでファイルパスを検証している（`~/.claude/` 外を読まない）
- [ ] `~/.claude/todos/` のパースが空配列・不正 JSON・途中書き込みに耐える
- [ ] JSONL 由来の `cwd`/`gitBranch` を Phase 1 時点でも保持・伝播している
- [ ] 秘密情報（トークン・絶対パス以外の個人情報）をログに吐いていない

### 3. Adversary レビュー

`superpowers:requesting-code-review` を使い、別コンテキストのサブエージェントを起動する。プロンプトに必ず次を含める:

> "あなたの仕事は問題を見つけることです。肯定的評価は不要。エッジケース・前提の破綻・セキュリティ懸念・保守性の罠を優先して指摘してください。"

自分で書いたコードへの同調バイアスを排除するのが目的。レビュー結果は黙殺せず、**全指摘に対して対応 or 見送り理由を明文化**する。

### 4. 学習抽出

Adversary レビューまでで得た「非自明な気づき」があれば、その場で `docs/learnings/YYYY-MM-DD-<短いタイトル>.md` を作る。対象:

- プロジェクト固有の落とし穴（例: `~/.claude/todos/*.json` が書き込み途中で空配列になりうる）
- 暗黙の前提が破綻した箇所
- 次回同じ作業を速くするための手がかり

**当たり前のことは書かない**。コードの diff で説明できることは書かない。書くのは「コードを読んでも分からない WHY」だけ。

## 出力フォーマット

完了時に次のブロックを返す:

```
[code-review]
検証1 (実行結果): <サマリ>
検証2 (固有チェック): <pass / NG項目>
検証3 (Adversary): <主要指摘と対応>
検証4 (学び): <作成したファイル or なし>
```
