# ADR-0004: JSONL による session 情報の enrich と project filter

- **Status**: Accepted
- **Date**: 2026-04-25
- **Deciders**: tahara_kazuki
- **Related**: ADR-0001, ADR-0002, ADR-0003

## Context

現状の Kanban は `~/.claude/todos/` の全 todo を混在表示している。
Claude Code の session は project を跨いで global に保存されるため、
「このプロジェクトで何やってるか」が UI 上で切り分けられない。

データソースは既に分かっている:

- `~/.claude/projects/{encoded-path}/{sessionId}.jsonl` のディレクトリ名が
  **cwd encoded-path**
- 各 JSONL 行に `cwd` と `gitBranch` が含まれる

CLAUDE.md の Phase 1 段階で「カードは JSONL 由来の `cwd` / `gitBranch` を
保持する」と前倒し宣言していたが未実装。本タスクで取り込む。

Phase 2 本体（同一リポジトリの複数 worktree 横串）と Phase 3（トークン消費
可視化）は本 ADR のスコープ外。

## Decision

### 1. JSONL パーサは core、session index は server

- **core** は fs から生データをパースして typed events を出すだけ
  - `packages/core/src/jsonl.ts`: JSONL 1行 → JsonlMessage 型、純粋関数
  - `packages/core/src/sessionWatcher.ts`: chokidar で `~/.claude/projects/`
    を監視し、新規 JSONL 発見時に最初のメッセージ行から
    `{ sessionId, cwd, gitBranch }` を抽出して `SessionMetaEvent` を emit
- **server** は session 状態を組み立て、todo event と突き合わせる
  - `packages/server/src/sessionIndex.ts`:
    `Map<sessionId, { cwd, gitBranch, lastSeen }>`
  - `startServer` 内で `watchSessionMeta()` を起動、
    SessionIndex を更新、todo upsert に enrich してから bus.publish

`SessionIndex` を core に置かない理由:
- 責務分離 (ADR-0001): core は UI/server 非依存の純粋観測層。
  複数ウォッチャーの結果を合流させる state 管理は server が持つ方が素直
- Phase 3 でトークン消費も JSONL から積算する際、同じ SessionIndex に
  `tokenUsage` を生やせば拡張でき、core は知らなくてよい

### 2. JSONL の読み方: **初回 discover 時に 1 行目の data message だけ読む**

JSONL は1セッションのメッセージ履歴全体で、長大（数百KB〜数MB）になる。
cwd/gitBranch は各行に書かれているが、session ライフタイム中は基本的に
不変（Claude Code は cd tool を持たない）。

- watcher の `add` イベントでのみファイルを開く
- `file-history-snapshot` 等のメタ行はスキップ
- 最初の `cwd` フィールドを持つ行を見つけたら即 close
- `change` イベントは無視（Phase 3 で token 集計時に read-through で再利用）

これにより起動時の全スキャンでも、332 セッション × 数KB の読み込みで済む。

### 3. Unknown 疑似プロジェクト

JSONL が存在しない session (稀だが、todo だけ書かれて projects/ に記録が
無いケース、または projects/ が古い session を手動削除済み等) は
`cwd = null` となる。

- wire format では `cwd?: string | null` (optional)
- web 側では `project: '(Unknown)'` として表示し、project dropdown の
  末尾にまとめる

### 4. ワイヤフォーマット拡張（下位互換）

既存の `UpsertSnapshot` に optional フィールドを追加:

```ts
type UpsertSnapshot = {
  meta: TodoFileMeta;
  path: string;
  items: TodoItem[];
  mtimeMs: number;
  // 新規 (optional)
  cwd?: string | null;
  gitBranch?: string | null;
  project?: string;  // display-ready 短縮形 ("task_viewer" など)
};
```

`project` は server が cwd から算出する display name。

### 5. Project 表示名の算出ルール

- `cwd = null` または不明 → `(Unknown)`
- cwd があれば basename を使う（`/Users/x/products/task_viewer` → `task_viewer`）
- 同じ basename が複数プロジェクトで衝突した場合、`parent/basename`
  まで含める（`/a/foo/web`, `/b/foo/web` は両方 `foo/web` に）
  - Phase 2 時点では単純化のため basename のみで開始
  - 衝突は ADR-0001 の worktree 対応で本格的に解く

### 6. UI は dropdown1つでフィルタ

- header 右端に `<select>` を置く
- オプション: `All projects` / 検出された各プロジェクト / `(Unknown)`
- 選択は `localStorage` に保存して reload 時に復元
- selected project は React の外で store に持たず、App ツリーの **useState
  のみ**で管理（filter は hook レイヤで集計）

### 7. TodoCard に project + branch を表示

カードの上段に `project / gitBranch` を小さいテキストで追加。cwd 末尾の
ディレクトリ名 + "@branch" 形式。

```
task_viewer @ main
sessionId 短縮
content
updated Xm ago
```

## Consequences

### 良いこと

- Phase 1 前倒し宣言が完了し、`cwd` / `gitBranch` がエンドツーエンドで
  流れる。Phase 2 の worktree 横串ビューは「同じ basename だが違う cwd」
  の集計をするだけで実装できる
- Phase 3 のトークン可視化で sessionIndex を拡張するだけで済む
- Project filter が入ることで「このプロジェクトでの流れ」が把握できる

### 悪いこと（受け入れるコスト）

- watcher が1本増え、server 起動時の初期スキャンが重くなる（数百 msec
  オーダ想定。実測して必要なら並列化）
- JSONL 読み取りは現状 add 時のみ。**session が進行中で cwd が途中で
  変わるケース**（ほぼ無いが原理的には可能）は追えない
- Unknown バケットが常に存在するため、UI に空プロジェクトが映る可能性が
  ある（Unknown 件数 0 なら dropdown から hide する対策）

### 代替案として却下

- **encoded-path ディレクトリ名を parse して cwd を復元**: `-` は元パスの
  `/` と `-` の両方から来るので lossy（`-wt-feature-a` は `/wt/feature/a`
  か `/wt-feature-a` か曖昧）。JSONL の中身を見る方が確実
- **SessionIndex を core に置く**: 責務違反 (#1)
- **project を server ではなく web で算出**: 同じロジックを wire で
  流す方が何度も描画しても安定し、Phase 3 の worktree 集計とも整合する
- **全ての JSONL 行を読んで token 集計まで一気に**: Phase 3 スコープ
