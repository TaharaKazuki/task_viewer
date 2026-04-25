# Phase 2 JSONL enrichment の Adversary レビュー学習

- **Date**: 2026-04-25
- **Context**: ADR-0004 に基づく JSONL enrichment + project filter の初期実装への adversary レビュー。20項目 (critical 2 / important 4 / suggestion 6 / nit 8)。ここまで core / watcher / server / web / web adversary と4回 adversary を回してきて、今回は**4回分で積み上がった設計パターンへの回帰バグ**が出やすいタイミング。

## 1. `Map.set` は**冪等性の意思を持って実装する**

`SessionIndex.apply` の最初の実装:

```ts
apply(ev: SessionMetaEvent): void {
  if (ev.kind !== 'discovered') return;
  this.map.set(ev.sessionId, { ... discoveredAt: Date.now() });
}
```

JavaScript の `Map.set` は同じキーを何度 set しても成功し、**結果が同じでも毎回実行される**。chokidar の `ignoreInitial: false` は全既存ファイルを走査するので、subagent が parent sessionId を再掲する（同じ cwd/gitBranch）だけで1 session あたり数回の set が発火する。

単なる上書きなら実害ゼロだが、**「変化があったか」を呼び出し側が知りたい場面**では致命的:

- late-discovery の再 emit 判定で、「発見された」が実質 no-op でも毎回 state scan が走る
- 将来、collision detection を入れるときに、冪等書き込みと真の上書きの区別がつかないと「同じ cwd で discover しただけ」でも警告が出てしまう

**対策**: `apply` が `{ changed: boolean; collided: boolean }` を返すようにし、呼び出し側で short-circuit:

```ts
const result = sessionIndex.apply(ev);
if (!result.changed) continue;  // skip re-emit
```

**教訓**: *Map/Set への write は「値が変わったか」を明示的に判定する口を持たせる*。JavaScript のデフォルトは「書き込んだら必ず成功」なので、呼び出し側が区別したいときは return 値で返す。

## 2. O(N × events) の scan は**2つ目の consumer が来る前に逆引きを置く**

`state.snapshot()` は `Array.from(this.map.values())` で O(N)。late-discovery pump が毎イベントこれを呼ぶと:

- 1 回の discovered = 1 回の full scan
- 14 discovered × 332 files = 4648 iterations

Phase 2 では負荷ゼロだが、**Phase 3 (token 集計) で JSONL 1行ごとに event を発行する**と、(行数 × state 件数) = 数万〜数十万の iteration に化ける。

**対策**: StateStore に `pathsBySessionId: Map<sessionId, Set<path>>` を追加。

```ts
pathsForSession(sessionId: string): UpsertSnapshot[] {
  const paths = this.pathsBySessionId.get(sessionId);
  if (!paths) return [];
  return Array.from(paths)
    .map((p) => this.map.get(p))
    .filter((s): s is UpsertSnapshot => s !== undefined);
}
```

**教訓**: *「2つ目の consumer」が来たら逆引き index を立てる*。正引きだけで済む間はよいが、別の key で引きたい consumer が登場したら即刻 index 化する。後付けは必ず load 時に発覚して高コスト。

## 3. **表示用の短縮名**を primary key にしてはいけない

`cwdToProject = path.basename(cwd)` で `/a/foo/web` と `/b/foo/web` が両方 `web` になる。最初は UI dropdown のラベル生成用だと思って実装したが、`useColumn` の filter key として `file.project === selectedProject` で使われ始めた瞬間、**2つの別プロジェクトが1つの bucket にサイレントマージ**される。

- Dropdown には1つしか出ない
- 選択すると両方の files が混ざる
- ユーザは気づかないうちに「foo の web」と「bar の web」を混同する

ADR-0004 §5 でこの衝突を「Phase 2 本体で解く」と deferred としたが、**storage レベルでは deferred にしてはいけない**:

- Storage は `cwd` (= unique) で引く
- Display label として `project` を添付する
- 衝突は observability の問題として `console.warn` で可視化する

**対策**: SessionIndex が `cwdsByProject: Map<project, Set<cwd>>` を持ち、set.size > 1 になった瞬間 collision 警告。Phase 2 本体で「parent/basename」や worktree 識別で display label を改善するときに、このメタデータから追跡できる。

**教訓**: *primary key = cwd、display string = project*。Phase 1 や MVP では同じに見えても、混在させた瞬間サイレントなデータ merge バグが仕込まれる。

## 4. localStorage 復元値は UI options と必ず**reconcile**する

`loadInitialProject` で保存済みの project 名を復元したあと、もしその project の file が全部消えていると:

- `useProjects()` の options にその値が含まれない
- `<select value={staleValue}>` は該当 option がないので React が warning
- UI 上は dropdown が「空」か別の選択肢を表示するが、state 上は stale value

ユーザは何を選んでるか分からなくなる。

**対策**: dropdown に「現在の値が options に無ければ `(no files)` の disabled option として明示表示」する:

```tsx
const hasCurrent = options.some(o => o.value === value);
{!hasCurrent && <option value={value} disabled>{value} (no files)</option>}
```

`value` を強制リセットはしない（ユーザが作業途中で一時的に「いま files 0 件のプロジェクト」を見てるケースを潰さないため）。

**教訓**: *永続化した UI 選択は次回 load 時に必ず現状と突き合わせる*。黙ってリセットすると混乱するし、黙って無視すると React warning。中間解として disabled 表示で「ズレてるよ」と伝える。

## 5. `readonly` は**runtime の保証にならない**

TypeScript の `readonly TodoItem[]` は compile time のみの保証。サーバの pipeline が core → enrich → state → bus → client まで同一の items array 参照を共有していた場合、any mutable consumer が runtime で壊せる。

レビュー指摘を受けて `enrich()` で `items: [...ev.items]` (shallow copy) を入れた。core の parser が fresh array を毎パース生成する現状では冗長だが、**信頼境界を跨ぐ入り口で1回コピー**しておくことで将来のリファクタ事故を防ぐ。

**教訓**: *readonly は TS 型上の hint、runtime 保証は別手段*。module 境界で shallow copy する / `Object.freeze` する / zod で parse する、のいずれかを必ず選ぶ。

## 一連の adversary 反省 (5回目)

5タスク連続で adversary を回して累計 100件以上の指摘。今回特徴的だった点:

- **既存パターンの回帰**: O(N×events) の scan (S1-2) は server の adversary で「ADR deferred 項目は実装する」と学んだパターンの反復
- **Display と storage の混同**: Phase 1 の watcher / server では「UI から見える形と内部の形を分ける」を学んでいたが、Phase 2 で `project` という display 文字列を storage key に使ってしまった
- **「冪等に見える write」の見落とし**: Map.set は冪等に感じるが、呼び出し側の「変化があったか」のシグナルを失う

パターン認識として書いておきたいチェックリスト:

1. **新しい write を足したら、「結果が同じでも呼ばれた」を区別したい consumer がいるか？** — Yes なら changed flag を return
2. **2つ目の access pattern が出たら、逆引き index を追加する** — 待つと必ず戻ってくる
3. **表示文字列と primary key は混ぜない** — 衝突検知のログ埋め込みまで計画する
4. **永続化した UI state は load 時に必ず現状と reconcile** — disabled-option 表示が既定の和解策
5. **trust boundary で shallow-copy を1回挟む** — readonly TS 型と併用しても runtime は別件
