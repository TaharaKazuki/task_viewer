# ADR-0001: monorepo レイアウトと責務分離

- **Status**: Accepted
- **Date**: 2026-04-24
- **Deciders**: tahara_kazuki

## Context

task_viewer は Claude Code の並列エージェント活動を Kanban で観測する Web アプリ。
データ源は `~/.claude/todos/*.json` と `~/.claude/projects/**/*.jsonl` の2系統で、
Phase 1 では前者のみ、Phase 2 以降で後者を統合する。

目先の Phase 1 だけを見ればシングルパッケージでも動くが、次の制約を満たす必要がある:

1. **パーサ／監視ロジックを UI やサーバに依存させたくない** — CLI 化・テストの単純化・別フロント差し替えの余地を残す
2. **Phase 2 の worktree 横串ビュー**で、同じパーサを `cwd`/`gitBranch` 付きで走らせる必要がある
3. **将来の Phase 3**（トークン消費可視化）で JSONL パーサを追加する際、todo パーサと対等な独立モジュールにしたい
4. biome/vitest/tsconfig などの開発基盤を**一箇所で共有**したい

## Decision

pnpm workspaces ベースの monorepo とし、次の3層に分割する。

```
task_viewer/
├── packages/
│   ├── core/     — UI/サーバ非依存のパースとファイル監視
│   └── server/   — Hono + SSE（core を読み取り、HTTP 層を提供）
│   ─────────── 以下は将来 ───────────
│   └── cli/      — core を直接叩く CLI（必要になったら）
└── apps/
    └── web/      — Vite + React + TanStack Query（server からの SSE を購読）
```

### 責務分離のルール

| レイヤ | 持ってよいもの | 持ってはいけないもの |
|---|---|---|
| `packages/core` | ファイル I/O、chokidar、zod スキーマ、パース関数、純粋なイベントストリーム抽象 | HTTP・SSE・React・Hono・ブラウザ API |
| `packages/server` | Hono・SSE・HTTP ヘッダ・認証（将来）・`core` の import | React・DOM・Vite |
| `apps/web` | React・TanStack Query・UI コンポーネント・`EventSource` | `core` への直 import（必ず `server` の HTTP API 経由） |

`apps/web` から `packages/core` を直接 import しないのは、将来フロントを別言語／別フレームワークに差し替える余地を潰さないため。

### パース関連の責務細分（core 内部）

| モジュール | 責務 |
|---|---|
| `todo.ts` | `~/.claude/todos/*.json` のファイル名・内容のパース（zod で検証） |
| `jsonl.ts`（Phase 3） | `~/.claude/projects/**/*.jsonl` の行単位パース、cwd/gitBranch/usage 抽出 |
| `watcher.ts`（次タスク） | chokidar ラッパー。上記パーサを組み合わせてイベントを流すだけ |
| `index.ts` | 公開 API の集約 |

**パース関数は副作用を持たない**（ファイル I/O はしない）。引数は文字列／ファイル名。実ファイル読みは呼び出し側（watcher もしくはテスト）の責務。テストしやすさのため。

## Consequences

### 良いこと

- Phase 2 の worktree 横串ビュー追加時に `core` に手を入れるだけで server/web が自動追従できる
- パース関数がピュアなので vitest で `raw string` → `parsed object` を直接検証できる
- 将来の CLI 化で `server` をバイパスして `core` を直接叩ける

### 悪いこと（受け入れるコスト）

- Phase 1 の段階では2パッケージだけで動くのに3ディレクトリ構造を先出しする分、初期セットアップが重い
- `apps/web` から `core` の型を共有したくなる場面が出たら、**型だけ re-export する薄い API を `server` 側に置く**ルールで対応する（`web` が `core` を直 import しない原則は崩さない）

### 代替案として却下

- **シングルパッケージ**: 当面は楽だが Phase 2 で必ず分割する必要があり、その時点での移行コストが monorepo 初期コストより大きいと判断
- **Turborepo / Nx**: pnpm workspaces だけで足りるスケール。タスクパイプラインが必要になったら再検討
