# task_viewer

Claude Code の並列エージェント活動を Kanban で観測するための Web アプリ。
L1AD/claude-task-viewer 着想。観察専用（read-only observer）であり、エージェントの起動・制御は行わない。

## スコープ

- **Phase 1（いま）**: `~/.claude/todos/*.json` を監視して、1セッション分のタスクを status 3列（pending / in_progress / completed）で表示する最小 Kanban
- **Phase 2**: 同一リポジトリの複数 worktree を束ねた「status × worktree」マトリクス横串ビュー
- **Phase 3 以降**: `~/.claude/projects/**/*.jsonl` と突き合わせたトークン消費・経過時間可視化

Phase 1 の段階から、各カードは JSONL 由来の `cwd` / `gitBranch` / 最終タイムスタンプを保持する。Phase 2 のデータ基盤を前倒しで敷いておくため。

## データソース（`~/.claude/` 配下）

- `todos/{sessionId}-agent-{agentId}.json` — タスク配列 `[{ content, status, id }]`
  - sessionId == agentId: 親エージェント
  - sessionId != agentId: Task ツールで spawn されたサブエージェント
- `projects/{encoded-path}/{sessionId}.jsonl` — セッションログ。各メッセージ行に `cwd`, `gitBranch`, `timestamp`, `message.model`, `message.usage` を含む

本家が前提にしている `~/.claude/tasks/` は現行 Claude Code には存在しない。`todos/` を正とする。

## 技術構成

- `packages/core` — todo パーサ、JSONL パーサ、chokidar 監視。UI 非依存
- `packages/server` — Hono + SSE
- `apps/web` — Vite + React + TanStack Query

`core` を独立パッケージにすることで、CLI や別フロントからも流用できる形にしておく。

## 開発フロー

タスクを受け取ったら **まず `dev-flow` スキルを起動すること**。タスク規模を判定し、必要に応じて superpowers の該当スキル（writing-plans, test-driven-development, systematic-debugging など）にチェーンさせる。実装完了後は必ず **`code-review` スキル**で検証 → Adversary レビュー → 学習抽出を回す。

個別スキルは `.claude/skills/` 配下、superpowers は `obra/superpowers-marketplace` プラグイン経由。

## ドキュメント運用

**CLAUDE.md をエージェントが書き換えない**。プロジェクトのルールや気づきは以下に書く:

- `docs/adr/NNNN-*.md` — アーキテクチャ決定記録（中規模以上のタスクで新設）
- `docs/learnings/YYYY-MM-DD-*.md` — 実装・レビューで得た気づきの蓄積先

CLAUDE.md 自体の更新は、プロジェクトのスコープや技術スタックが変わった時のみ人間が行う。

## 参考

- 本家: https://github.com/L1AD/claude-task-viewer
- スキル設計の背景: https://zenn.dev/dk_/articles/1f3fbc506827ac
