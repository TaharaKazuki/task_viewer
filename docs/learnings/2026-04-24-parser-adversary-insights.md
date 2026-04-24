# パーサ着手時の Adversary レビューで浮いた設計知見

- **Date**: 2026-04-24
- **Context**: `@task-viewer/core` の最初のパーサ実装 + Adversary レビューの往復で得た、コードを読んでも分からない WHY たち。

## 1. `"types": ["node"]` は tsconfig 経由の ADR リーク

`packages/core` は ADR-0001 で「UI/サーバ非依存」と宣言している。
初期状態の `packages/core/tsconfig.json` は `"types": ["node"]` を入れていたが、
これは **ambient に node の API を grant する設定**で、将来の PR で誰かが
`import fs from 'node:fs'` を書き足しても型エラーにならない状態を作っていた。
ADR の宣言が tsconfig に反映されていないと、レビューで気づくまで沈黙するリーク源になる。

**対策**: pure パッケージの tsconfig は `"types": []` にする。必要なときだけ
devDependency で `@types/node` を拾う層（`packages/server` や Vitest を直接
呼ぶ層）に閉じ込める。今後ほかの pure パッケージを切るときも同じ扱い。

## 2. `safeParse` が `[]` を返すと「正常空配列・途中書き込み・スキーマ破綻」が区別できない

最初の実装は失敗時 `[]` フォールバックだった。楽に見えて実害が大きく:

- 正常な空ファイル `[]` と、壊れたファイルを区別できない
- 監視ループが「スキーマが静かに変わった」ことを検知できず、
  ずっと 0 件が表示されるだけで障害として現れない

ADR で「core は UI-agnostic」と書いた意図は、**エラー情報を UI 層の都合で
切り捨てない**ことでもある。結果を失敗理由付きの discriminated union で返す
(`{ ok: true, items } | { ok: false, reason: 'json' | 'schema' | 'too_large' }`)
ことで、watcher 層が「静かに飲む」「ログ出す」「アラート」を選べる。

**教訓**: pure パーサが握るべきエラー情報を、呼び出し側の都合で握りつぶさない。

## 3. UUID の大文字小文字は Map キーの地雷

macOS (APFS) / Windows (NTFS) は case-insensitive-but-preserving。
`AAA...-agent-AAA....json` と `aaa...-agent-aaa....json` は**同じファイル**だが、
`TodoFileMeta.sessionId` に生の文字列を入れておくと `Map<sessionId, ...>` が
二重登録される可能性がある。

**対策**: パース境界で lowercase 正規化する（ルックアップ時ではなく）。
同じ原則は、後で `cwd`/`gitBranch` を Map キーに使うときも適用する。

## 4. 並行書き込み truncation は**形式は壊れないが意味が壊れる**ことがある

テストで扱う `[{"id":` のような明らかな truncation は JSON.parse が落ちるので
検知できる。厄介なのは、Claude Code が非アトミックに書き戻すファイルを
**古い書き込みのバッファ境界**で読んだ場合、`status: "in_progress"` のまま
残った末尾が valid な JSON として組み合わさることがあり得る。単体テストでの
再現は困難。

**教訓**: 検知不能な truncation の存在を前提に、**watcher 層で「前回と同一
内容なら再処理しない」「短いデバウンスを入れる」**を組み合わせる。parser
単体で保証しきれない安全性があることを覚えておく。

## 5. zod `.strict()` は prototype pollution + schema drift の両方に効く

`.strict()` なしの `z.object` は未知フィールドを silently drop する。
`__proto__` や `constructor` を含むペイロードは JSON.stringify 経由だと
リテラル扱いで消えるが、手書きの JSON 文字列（実ファイル経由）だと残る。
`.strict()` にしておけば:

- `__proto__` 入りペイロードを早期に拒否
- Claude Code 側がフィールドを増やした瞬間にテストで気づく（silently drop しない）

「未知のフィールドが来たら落ちる」は一見アグレッシブだが、観測ツールとして
正しい。上流スキーマが変わったことを知らずに無視し続ける方が危険。

## 6. `JSON.stringify` と `__proto__` の罠

テストでプロトタイプ汚染ペイロードを作るときに、`{ __proto__: {...} }` を
`JSON.stringify` してもキーは出力されない（`__proto__` はオブジェクト
リテラルでは `setPrototypeOf` に変換されるため）。**ハンドクラフトの JSON
文字列でないと意味のあるテストにならない**。
