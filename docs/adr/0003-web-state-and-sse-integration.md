# ADR-0003: apps/web の状態管理と SSE 統合

- **Status**: Accepted
- **Date**: 2026-04-24
- **Deciders**: tahara_kazuki
- **Related**: ADR-0001, ADR-0002

## Context

`packages/server` が `/events` SSE エンドポイントで `snapshot` → 続く
`upsert` / `remove` / `error` / `ready` を吐く。`apps/web` はこれを購読して
React Kanban UI として表示する。

設計上の分岐点:

1. **どのライブラリで SSE → React state を結ぶか**（TanStack Query / Zustand /
   Jotai / 自前 Store + `useSyncExternalStore` / ...）
2. **state の形**（配列 vs path-keyed Record）
3. **SSE 接続の所有者**（コンポーネントローカル vs アプリ全体で1本）
4. **Kanban のカード粒度**（ファイル単位 vs ファイル内アイテム単位）
5. **dev サーバのオリジン**（別オリジン + CORS vs 同一オリジン + proxy）

## Decision

### 1. `useSyncExternalStore` + 自作 Store クラス（TanStack Query は使わない）

React 18+ 標準フック `useSyncExternalStore` で、自作 `SSEStore` を購読する。

**なぜ TanStack Query ではないか**:

- Query は request-response 前提で、SSE のようなプッシュ型 stream には
  `setQueryData` で注入する形になり、本来のキャッシュ機能（stale/fresh
  判定・refetch）がほぼ使われない
- 観察ツールの状態は「SSE で流れてきたイベントの畳み込み」でしかなく、
  Query の派生機能（mutation・optimistic update 等）は Phase 1-2 では不要
- 依存を1つ減らせる（バンドルサイズ・設定ファイル・学習コスト）

**トレードオフ**: 専用 DevTools パネルは失う。代わりに React DevTools の
コンポーネントタブで props/state が見えるので実用上は問題ない。
困ったら window に store を露出して devtools 的にするのは容易。

### 2. State は path-keyed `Record<string, UpsertSnapshot>`

SSE イベントが path キーで来るので、Record で持てば `upsert` / `remove`
が O(1) で当たる。配列だと毎回 `findIndex` → `splice` で O(n)。

派生ビュー（status 別の配列、session 別の集約）は **selector 関数**で
都度計算する。メモ化が要るほど重くはない（数百ファイル × 数十アイテム）。

### 3. SSE 接続は `<SSEProvider>` で1本だけ張る

アプリのルートでだけ `new EventSource('/events')` し、`<SSEProvider>` が
所有する。コンポーネントはフック経由でだけ store に触る。

- コンポーネントローカルに `useEffect(() => new EventSource(...), [])` すると、
  マウント/アンマウントの度に接続が切れ、snapshot の再送負荷が server に
  かかる（300+ファイル × 接続毎回）
- サーバは 1 プロセス上で multi-consumer fan-out を想定（ADR-0002）
  しているが、UI クライアント1枚で複数接続張るのは責務が逆

### 4. Kanban のカード粒度は **(file, item) タプル**

```
Column: pending        Column: in_progress   Column: completed
  ┌──────────────┐      ┌──────────────┐      ┌──────────────┐
  │ session A    │      │ session A    │      │ session A    │
  │ item #2      │      │ item #3      │      │ item #1      │
  │ "xxx"        │      │ "yyy"        │      │ "zzz"        │
  └──────────────┘      └──────────────┘      └──────────────┘
```

1 ファイルが複数ステータスの item を持つので、ファイル単位のカードにすると
「どの session が何を進行中か」が曖昧になる。item 単位のカードにして、
カード自身に session 情報（sessionId 頭8文字 + subagent バッジ）を載せる。

派生タスクとして、Phase 2 で **session 単位にグルーピング**する別ビューを
足す可能性はあるが、Phase 1 の Kanban 基本形としては item 単位が自然。

### 5. Vite dev proxy で同一オリジン化

`vite.config.ts` で `/events` と `/healthz` を `http://127.0.0.1:4321` に
プロキシする。これにより:

- web 側コードは `new EventSource('/events')` と書ける（絶対 URL 不要）
- ブラウザから見ると同一オリジン扱いなので、CORS は通らない経路
- 本番ビルドは将来 server 側で静的ファイルを配信する or 別オリジン + CORS
  で対応（Phase 1 スコープ外）

### 6. スタイリングは Tailwind CSS

Vite + React + Tailwind の組み合わせは業界標準。shadcn/ui は Kanban 程度の
UI には過剰なので入れない。Tailwind の utility classes だけで Phase 1 の
Kanban レイアウトは完結する。

### 7. 公開 hooks の形

```ts
function useTodoFiles(): Record<string, UpsertSnapshot>;
function useConnectionStatus(): { state: 'connecting'|'open'|'closed'|'error'; error?: string };
function useColumn(status: TodoStatus): Array<{ file: UpsertSnapshot; item: TodoItem }>;
```

`useColumn` が selector 役で、Kanban 各列はこれだけを呼べば済む。

## Consequences

### 良いこと

- 依存が少ない。apps/web の `dependencies` は `react`, `react-dom` のみ
- 状態の形が単純で、`applyEvent(prev, event): next` のピュア関数1つが
  コアロジックで、単体テストがしやすい
- proxy で CORS・オリジン関連の罠を開発中は回避できる

### 悪いこと（受け入れるコスト）

- TanStack Query の DevTools が使えない。代替は React DevTools とブラウザ
  コンソールで `window.__sseStore.getSnapshot()` 的な露出（dev only）
- SSE 接続のリトライロジックは EventSource 組み込みのものに任せる。
  詳細な backoff カスタマイズが必要になったら自作する

### 代替案として却下

- **TanStack Query**: #1 の理由。push 型に対しては機能が半分しか使えない
- **Zustand / Jotai**: useSyncExternalStore で足りる規模。外部ライブラリを
  追加する価値が見合わない
- **ファイル単位のカード**: #4 の理由。複数ステータス item の表現が崩れる
- **別オリジン + CORS**: dev で `Origin: http://localhost:5173` をコードに
  ハードコードする or 環境変数で分岐する必要が出て、proxy より面倒
