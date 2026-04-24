---
name: dev-flow
description: Use at the start of every non-trivial task in this repo. Classifies task size (small/medium/large) and dispatches the right chain of superpowers sub-skills plus the project's code-review gate. Invoke BEFORE writing code — not after.
---

# dev-flow — task orchestrator for task_viewer

このリポジトリで新しいタスクを受け取ったら、実装に着手する前に必ずこのスキルで段取りを決める。

## 役割

1. タスク規模を判定する
2. 既存 ADR（`docs/adr/`）を必ずスキャンし、関連決定があれば遵守する
3. 規模に応じたスキルチェーンを選ぶ
4. 実装後は必ず `code-review` スキルで締める

## 規模判定の目安

| 規模 | 目安 | チェーン |
|---|---|---|
| 小 | 1-2ファイル・既存機能の修正・バグ修正 | （準備なし）→ 実装 → `code-review` |
| 中 | 3-5ファイル・新規コンポーネント1つ・既存モジュールの拡張 | `superpowers:writing-plans` → 実装（必要なら `superpowers:test-driven-development`）→ `code-review` |
| 大 | 新規パッケージ・新エントリポイント・データフロー追加 | `superpowers:brainstorming` → ADR 起票（`docs/adr/NNNN-*.md`）→ `superpowers:writing-plans` → `superpowers:test-driven-development` → `code-review` |

迷ったら1段階大きい方を選ぶ。

## ルール

- **CLAUDE.md は触らない**。学び・ルールは `docs/learnings/YYYY-MM-DD-*.md` へ、設計決定は `docs/adr/NNNN-*.md` へ。
- **中・大規模で ADR を新設しない言い訳を作らない**。決めたことは残す。
- デバッグに入ったら迷わず `superpowers:systematic-debugging` を挟む。
- worktree を切る作業が含まれる場合は `superpowers:using-git-worktrees` を参照する。
- 計画を立てた直後に実装へ突入せず、**ユーザーに計画を提示して合意を取る**（大規模のみ必須、中規模は推奨）。

## 出力フォーマット

タスクを受け取ったらまず次を返す:

```
[dev-flow] 規模: <小|中|大>
根拠: <1-2行>
関連ADR: <番号 or なし>
チェーン: <ステップを矢印で>
```

このブロックを出してから実装・サブスキル呼び出しに進む。
