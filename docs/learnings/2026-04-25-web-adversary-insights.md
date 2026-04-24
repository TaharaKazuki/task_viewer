# apps/web の Adversary レビューで浮いた設計知見

- **Date**: 2026-04-25
- **Context**: `@task-viewer/web` 初期実装 (React 19 + useSyncExternalStore + SSE) への adversary レビューで出た問題。全 18 項目のうち critical 2 / important 5 / nit 11。同じセッションで core / server にも各1件ずつ大きめの adversary 学習を書いてきたが、**React + push型ストリームの組は別種の footgun を持っている**。

## 1. `useSyncExternalStore` の selector が**毎回 fresh オブジェクトを返すと壊れる**

以下は React 18/19 でも無効コード:

```ts
useSyncExternalStore(
  store.subscribe,
  () => ({ state: s.connection, errorMessage: s.errorMessage, ready: s.ready }),
);
```

- `useSyncExternalStore` は render 中と通知後に `getSnapshot` を呼び、返り値を `Object.is` で比較する
- `{ ... }` リテラルは毎回別参照 → 「変わった」と判定 → tearing warning / 不要な再 render
- React 18 では infinite loop を起こしていた。React 19 では許容される可能性はあるが、**tearing の保証が消える**し、unrelated な `files` upsert で ConnectionStatusBar も再 render される

**対策**: **store 側で派生ビューを持ち、依存フィールドが変わったときだけ新しい参照にする**:

```ts
class SSEStore {
  private connectionView = deriveConnectionView(INITIAL_STATE);

  getConnectionView = (): ConnectionView => this.connectionView;

  private setState(update) {
    const next = update(this.state);
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    if (
      next.connection !== prev.connection ||
      next.errorMessage !== prev.errorMessage ||
      next.ready !== prev.ready
    ) {
      this.connectionView = deriveConnectionView(next);
    }
    for (const l of this.listeners) l();
  }
}
```

これで `useSyncExternalStore(store.subscribe, store.getConnectionView)` が安定。

**代替**: `use-sync-external-store/with-selector` パッケージの `useSyncExternalStoreWithSelector` に shallow-eq comparator を渡す。依存が1個増えるのと引き換えに、コンポーネント側だけで処理できる。今回は store 側に寄せた。

**教訓**: *External store pattern で selector は必ずメモ化する*。手書きなら store に cache、楽するなら with-selector。

## 2. `useMemo(() => new X(), [prop])` はシングルトンに使ってはいけない

```tsx
// ❌ prop identity が変わると別インスタンスが作られる
const store = useMemo(() => storeProp ?? new SSEStore(factory), [storeProp, factory]);

useEffect(() => {
  store.connect(url);
  return () => store.close();
}, [store, url]);
```

- parent が inline `factory={(u) => ...}` を渡すと毎 render で factory 参照が変わる
- `useMemo` は deps 変化で再計算 → 新 store 生成
- **useEffect cleanup は古い store の close() を呼ぶが、これは新 store 代入の *後*にキューされる** — 古い EventSource はもう参照を失っており、イベントリスナーが生き残ったまま FD リーク
- StrictMode 下ではこの動作が見える形で起きる

**対策**: useRef + lazy init:

```tsx
const storeRef = useRef<SSEStore | null>(null);
if (storeRef.current === null) {
  storeRef.current = storeProp ?? new SSEStore(factory);
}
const instance = storeRef.current;
```

**教訓**: *useMemo はライフサイクル primitive ではない*。生成物をコンポーネントライフタイムに束縛したいなら useRef。これは React の一般則だが、SSE のような external resource を握るオブジェクトだと事故が顕在化しやすい。

## 3. SSE auto-reconnect は**"transient state クリアの節目"**として扱う

EventSource は TCP 切断時に自動再接続する。再接続後は server がまず新しい snapshot を送る。このとき:

- 古い `errorMessage` が残ったままだと、「エラー解決済みだが UI には red banner」状態に陥る
- `connection` も 'error' のまま見えうる

applyEvent の `snapshot` 分岐を「fresh start 信号」として使い、`errorMessage: null` + `ready: false` + `connection: 'open'` を同時にセットする。

**教訓**: *再接続後のクリーンアップは reducer のトランザクション境界に埋め込む*。コンポーネントで「error が来なくなったら consulted」的に hack するより、データフローの上流で一貫した状態を保証する方が堅い。

## 4. **到着順が保証されない**イベントは reducer で補償する

EventSource の仕様上、`open` イベントと最初のメッセージの到着順は browser 実装依存 (Firefox はバッファ済みメッセージを先に flush することがある)。

素直に書くと `connection === 'open'` は `open` ハンドラでしか立たず、最初の snapshot 到着時はまだ "connecting…" のまま UI に表示される。

**対策**: **データイベント到着 = 接続開通の十分条件**として扱う:

```ts
case 'snapshot':
case 'upsert':
case 'remove':
case 'error':
case 'ready':
  return { ...prev, connection: markOpen(prev.connection), ... };

// 意図的に close() された後はデータ到着でも 'closed' のままにする
function markOpen(c) { return c === 'closed' ? c : 'open'; }
```

**教訓**: *「プロトコル上の順序」と「ユーザから見える状態遷移」は別物*。純粋関数 reducer に両者を同居させて、順序に依らない state を合成する。

## 5. duplicate-delivery 前提の reducer には short-circuit を入れる

ADR-0002 で「subscribe-first policy により同じ upsert が重複配信されうる (冪等なので OK)」と宣言している。

が、何も対策しないと: `applyEvent` の `upsert` 分岐は毎回 `{ ...prev, files: { ...prev.files, [path]: ev } }` で新オブジェクト。subscriber は毎回 re-render。

**対策**: mtimeMs が一致したら前状態を参照のまま返す:

```ts
case 'upsert': {
  const existing = prev.files[ev.path];
  if (existing && existing.mtimeMs === ev.mtimeMs) return prev;
  // ...
}
```

**教訓**: *ADR で「冪等で OK」と書いたら、reducer で冪等性を実装する*。server 側での dedup と web 側での dedup は別レイヤ。

## 6. `Record<SomeUnion, T>` と `Record<string, T>` は型安全性が大きく違う

```ts
// ❌ どんな文字列でも引けるので index 結果が T | undefined 扱いに
const LABEL: Record<string, {text; className}> = { ... };

// ✅ 列挙と exhaustive チェック
const LABEL: Record<ConnectionState, {text; className}> = { ... };
```

union 型を key にすれば、**missing case が compile error**になるし、access も常に T (non-undefined)。

**教訓**: *enum / union を key にした mapping は `Record<Union, T>` で書く*。index access の optional chaining ノイズも消える。

## 7. ErrorBoundary + `createRoot({ onUncaughtError, onCaughtError })` は **React 19 以降の最低ライン**

malformed な SSE payload や component の throw で白画面になる。React 19 は `createRoot` に両 handler を渡せるので:

```ts
createRoot(rootEl, {
  onUncaughtError: (err) => console.error('uncaught:', err),
  onCaughtError: (err) => console.error('caught:', err),
}).render(<App />);
```

加えて top-level の `<ErrorBoundary fallback={...}>` で UI 継続。Phase 1 は簡易でいいが、**無いと全セッション白画面のリスク**。

## 8. 決定論的な tiebreaker を sort に入れる

`sort((a, b) => b.mtimeMs - a.mtimeMs)` だけだと、同 mtime のペアで JS Array.sort は (V8 では stable だが) ロジックとして不定。fs の mtime は ms 精度で衝突しうるし、テストでは常に同値になる。

**対策**:
```ts
if (dt !== 0) return dt;
if (a.path !== b.path) return a.path < b.path ? -1 : 1;
return a.id < b.id ? -1 : 1;
```

**教訓**: *UI 表示順の安定は ad-hoc に頼らない*。primary key が衝突しうる場面は全て tiebreaker を明示。

## 一連の adversary 反省

core / watcher / server / web と 4 タスク連続で adversary を回して、それぞれの layer 固有の footgun が出そろった:

- **core**: AsyncIterator の resolver single-slot / return() のリソース解放
- **watcher**: long-lived pump の error propagation / symlink / write truncation semantics
- **server**: subscribe 順序 / backpressure の ADR deferred が実装されない危険 / listening callback と error listener の対称性
- **web**: selector の identity / useMemo が singleton に向かない / reconnect 時の transient state

**共通パターン**: どれも「データフローの端っこ（入力境界・出力境界）」で起きる。中の純粋関数は比較的バグらない。**境界の契約を ADR と learning で明示してから実装**する今のサイクルは、adversary レビュー1回あたり 4-9 件の critical/important を拾えている。次タスクからは**実装前に adversary レビュー観点のセルフチェックリスト**を挟むと、もう 1 段効率が上がる可能性がある。
