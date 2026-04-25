# ADR-0005: JSONL から TodoWrite を抽出する第二の watcher

- **Status**: Accepted
- **Date**: 2026-04-25
- **Deciders**: tahara_kazuki
- **Related**: ADR-0001, ADR-0002, ADR-0004

## Context

VSCode 拡張モードの Claude Code は `~/.claude/todos/{sid}-agent-{aid}.json` に
TodoWrite 状態を**永続化しない**（CLI モードは書く、本日の調査で確認）。
そのため、ADR-0001/0004 の前提だった `todoWatcher` だけでは VSCode から
発火している TodoWrite が観測できず、Kanban に映らない。

ただし、**`~/.claude/projects/**/*.jsonl` の中には TodoWrite tool_use の
履歴が必ず書かれている**（CLI/VSCode 両モード共通）。これを抽出すれば
全モードで TodoWrite を観測できる。

本家 (L1AD/claude-task-viewer) は `~/.claude/tasks/` という旧レイアウトに
依存しており、JSONL からは customTitle/slug/cwd だけを取り出していて
TodoWrite は parse していない。本プロジェクトでは現行 Claude Code の
レイアウトに合わせて、**JSONL から TodoWrite を抽出する第二の watcher**
を追加する。

## Decision

### 1. **共存方式**: `todoWatcher` を残しつつ `jsonlTodoWatcher` を追加

| ソース | 担当 | path |
|---|---|---|
| `todoWatcher` (existing) | CLI モードの永続 todo (高速・小サイズ) | `~/.claude/todos/{sid}-agent-{aid}.json` (real) |
| `jsonlTodoWatcher` (新規) | VSCode/CLI 共通の JSONL 由来 | 同じ合成パス (synthetic) |

両 watcher は **同じパスの TodoFileEvent を emit する**。state は path-keyed
なので natural last-write-wins で coalesce する。実運用では JSONL の方が
高頻度に更新されるため、CLI session でも jsonl 由来が支配的になる。

### 2. **`source: 'todos' | 'jsonl'` を wire に乗せる**

両ソースを区別できるようにする。

```ts
type UpsertSnapshot = {
  meta; path; items; mtimeMs;
  cwd; gitBranch; project;
  source: 'todos' | 'jsonl';  // 新規
};
```

UI のカードに小さなバッジを付け、IDE モードで動かしている人が「いま自分の
TodoWrite が JSONL 経由で見えてる」と分かる。デバッグにも便利。

source の付与は **server の各 pump 側**で行う:
- `todoWatcher` から来たイベント → enrich(ev, info, 'todos')
- `jsonlTodoWatcher` から来たイベント → enrich(ev, info, 'jsonl')

core は source agnostic のまま (ADR-0001 の責務分離)。

### 3. **JSONL は incremental tail で読む**

JSONL は append-only で大きい (4MB 超もザラ)。session 中に何度も full read
すると CPU を食う。

- per-file state: `{ lastOffset, partialLine, lastEmittedTodoSig }`
- chokidar `add` 時: offset=0 から末尾までを read、抽出、offset 更新
- chokidar `change` 時: 200ms debounce → lastOffset から末尾までを read、
  partialLine を頭にくっつけて改行で split、新しい完全行のみ parse、
  partial を末尾に分離して保存
- 抽出した TodoWrite が前回と同じ (signature 比較) なら emit しない

debounce は同じ JSONL に短時間で連続書き込まれるケース (複数 tool_use を
1ターンに含むセッション) でも、最後の状態だけ emit する。

### 4. **Truncation/rotation は full re-scan で安全側へ**

`stat.size < lastOffset` を検知したら "ファイルが切り詰められた / 別ファイルに
入れ替わった" 扱いで offset=0 にリセットして全 read。append-only 前提が
破れる場面 (rare だが claude code 側のクリーンアップ等) に備える保険。

### 5. **Subagent JSONL も拾う**

`~/.claude/projects/{cwd-encoded}/{parent-sid}/subagents/agent-{aid}.jsonl`
の中身は `sessionId: parent_sid, agentId: subagent_aid`。これも拾えば
subagent (Task ツール由来) の TodoWrite が独立カードとして Kanban に
リアルタイム流れる。既存の todoWatcher が subagent を表示する挙動と一致。

合成パスは `~/.claude/todos/{parent_sid}-agent-{subagent_aid}.json`。
todoWatcher 側でも同じ pattern なので、CLI subagent と JSONL subagent が
同一エントリにマージされる。

### 6. **TodoWrite の "最新" の意味**

JSONL は append-only。session 中に TodoWrite が複数回呼ばれる (e.g., 進捗
更新するたびに) と、最新の input.todos が現在の状態。watcher は **末尾
方向の最後の TodoWrite tool_use** を返す。

抽出時は `lastEmittedTodoSig` (例: 末尾 todo の `id+status` を JSON.stringify)
を保持し、増分 read で見つかった TodoWrite が前回と同一 signature ならば
emit を抑制する。

## Consequences

### 良いこと

- **VSCode/IDE モードでも TodoWrite が観測できる** (元の動機)
- CLI モードでも JSONL が source なら最新性で勝つので、CLI session の
  内訳がより精密に追える
- **subagent の TodoWrite が初めて Kanban に映る**(これまで todoWatcher
  でも拾えてはいたが、永続化されない CLI subagent は欠落していた)
- 本家にない差別化ポイント (CLAUDE.md の "自作する意味" の一つ)

### 悪いこと（受け入れるコスト）

- watcher が3本になる (todo / session / jsonlTodo)。close 時の orchestration
  コードが少し増える
- JSONL の incremental tail のステート管理が必要 (lastOffset, partialLine
  バッファリング)。バグると data corruption っぽい挙動に出るので、テストを
  しっかり書く
- 両ソースが同じパスを emit すると、本来 idempotent な event でも
  source 切替時に state が新参照を取り直して subscriber が再 render する
  (許容範囲: web 側 applyEvent が source 変化を short-circuit 対象にする)

### 代替案として却下

- **JSONL に完全移行 (todoWatcher 廃止)**: JSONL parse は重く、CLI mode の
  軽さ (数 KB の JSON 1ファイル) を捨てる必要はない。共存の方が両モードで
  最良
- **異なる path を使って両ソースを別 entry にする**: 同じ session が CLI と
  IDE で同時に動くケースは普通ないが、もし起きると Kanban が複製される
  違和感が大きい。同一 path で coalesce する方が UX 的に正解
- **server が dedup ロジックで「JSONL があれば todos/ 無視」**: ADR-0002
  の "server は state owner" の延長として書けるが、同一 path coalescing で
  自然に解決するので追加ロジック不要
