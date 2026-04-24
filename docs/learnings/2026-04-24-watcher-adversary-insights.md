# chokidar watcher の Adversary レビューで浮いた設計知見

- **Date**: 2026-04-24
- **Context**: `packages/core/src/watcher.ts` の最初の実装に対する adversary レビューで得た、後から再発しやすい落とし穴たち。

## 1. AsyncIterator の resolver は**単一スロットだと黙って迷子になる**

`next()` が buffer 空のときに新しい Promise を作って resolver を保存する実装は、
**resolver をフィールドに1つだけ保持する**と、次の `next()` 呼び出しが resolver を
上書きして、前の Promise が永遠に解決されない。

特に **`Promise.race([iter.next(), timeout])` パターン**でテストが壊れる。timeout
側が勝っても `iter.next()` 側の Promise は pending のまま生き残り、次に `iter.next()`
を呼んだ瞬間に resolver が入れ替わる → 前の consumer は永久に待つ。

**対策**: resolver を **FIFO Array** で管理し、`push` 時に `shift` して解決する。
`endIterator` でもキュー全体を done で解決する。

## 2. `iterator.return()` はリソース解放の契約である

`for await` の `break` や `throw` は、裏で `iter.return()` を呼ぶ。ここで
**外部リソース（chokidar の FD、FSEvents subscription、debounce timer）を解放
しない**と、consumer が break するだけで watcher が生き残り、FD リークになる。

実装の `return()` と `stop()` は **同じ teardown 関数**を呼ぶのが正解。
teardown は `closed` flag で冪等にしておく（ダブルコール安全）。

**教訓**: AsyncIterable を公開する関数は、`return()` を forget しないこと。
MUST-free のリソースがあるなら `return()` で必ず await する。

## 3. 観測系の buffer は**どこかに背圧の置き場所**を置く

chokidar fan-out + 遅い SSE クライアント = `buffer` が無限に伸びて OOM。
`core` 層で全部解決しようとせず、「buffer は無制限、背圧は server/SSE 層の責務」
と明示的に決めておき、server 側で `upsert` を path で coalesce する設計にする。

同じ path の古い `upsert` は捨てていい（最新状態だけ欲しい観測系の特性）。
この性質が「観測 vs 制御」の境目で効く。

**対策**: watcher は buffer 無制限のまま、server 層で `Map<path, TodoFileEvent>`
で coalesce して SSE flush 時に最新だけ送る。Phase 2 で実装する。

## 4. `fs.read + fs.stat` は非アトミック — でも観測系は受け入れていい

`Promise.all([readFile, stat])` は2 syscall。書き込みとぶつかれば `raw` と
`mtimeMs` が食い違う revision を指す可能性がある。

**判断**: Phase 1 の観測ツールでは受け入れる。正確な dedup が要るなら
Phase 2 で content hash ベースに切り替える（mtime は表示用に留める）。
stat-then-read-then-restat のリトライは複雑さに見合わない。

## 5. macOS `/tmp` symlink は chokidar テストを高確率で噛む

`mkdtempSync(tmpdir())` は `/var/folders/...`（実体）と `/tmp/...`（symlink）を
返しうる環境があり、chokidar が realpath 展開して返すパスと consumer が
期待するパスがズレる。

**対策**: `dir = realpathSync(mkdtempSync(...))` を `beforeEach` で必ずかける。
Linux でも無害（no-op）、macOS では必須。

## 6. chokidar の `awaitWriteFinish` は検討価値あり

現状は自前の `debounceMs` で rapid writes を合流している。chokidar には
`awaitWriteFinish: { stabilityThreshold, pollInterval }` があり、**書き込み
完了を検知してから add/change を emit する**オプション。

**将来改善案**: これを有効にすれば、truncated-JSON → `{ kind: 'error' }` の
phantom emission が減る可能性がある。今は debounce で十分なので後回しだが、
SSE に流してみてエラーイベントが頻発するようなら導入を検討。

## 7. chokidar の error handler 引数型は `unknown`

`fsWatcher.on('error', (e: unknown) => ...)` と来る。`as Error` でキャスト
していたが、非 Error（文字列、EACCES の独自オブジェクト等）を受け取ると
type lie になる。

**対策**: `toError(e: unknown): Error` ヘルパで **`e instanceof Error ? e : new Error(String(e))`** を通す。chokidar 以外の try/catch でも同じ。

## 再発防止

- AsyncIterable を公開する関数を書くときは、この learning の1と2を最初にチェック
- 観測系の buffer は無制限が default、背圧は外側に置く（3）
- chokidar テストは realpathSync から（5）
