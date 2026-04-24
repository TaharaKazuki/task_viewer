# ADR-0002: SSE ストリーミングと server 層オーナーシップ

- **Status**: Accepted
- **Date**: 2026-04-24
- **Deciders**: tahara_kazuki
- **Related**: ADR-0001

## Context

`packages/core` が `watchTodos()` を通じて `TodoFileEvent` の AsyncIterable を提供するところまではできている。これを複数の UI クライアントに配る層 (`packages/server`) を作るにあたって、以下の設計境界を凍結する必要がある。

前タスク (watcher 実装) の adversary レビューで以下の課題が明示されていた:

- core の watcher は **single-consumer**（複数 iterator が buffer を奪い合う）
- core の buffer は**無制限**（backpressure 未実装）
- core は UI-agnostic なので、スナップショットのような UI 都合の状態を持たない

この ADR でこれらの責務配分を決める。

## Decision

### 1. **SSE を採用する**（WebSocket ではない）

| 観点 | 決定根拠 |
|---|---|
| 通信方向 | 観察専用ツールなので**サーバ→クライアントの片方向**で十分 |
| 自動再接続 | ブラウザ組み込みの `EventSource` が TCP 切断時に自動再接続する |
| プロトコル | 通常の HTTP `text/event-stream` なので HTTP サーバの全エコシステムに乗る |
| 実装量 | Hono の `streamSSE` で数十行に収まる |
| バックエンド差し替え | 将来 Node 以外（Go/Rust）への書き換えコストが低い |

### 2. **UI からの命令系が必要になったら HTTP POST エンドポイントを別立てする**

将来「Kanban からエージェントに指示を送る」方向性が出たら、SSE を双方向化するのではなく、`POST /commands/...` のような **観測と命令で別 API** にする。これにより:

- SSE を純粋な read-only stream に保てる
- 命令系には必要に応じて認証・idempotency key・audit log を独立で被せられる
- Phase 1 の「観察専用」スコープが崩れない

### 3. **状態のスナップショットは server が保持する**

新規クライアントが接続した瞬間に過去の todo ファイル状態を知る必要があるため、server は内部に `Map<path, UpsertSnapshot>` を持つ:

- watcher からの `upsert` で set、`remove` で delete
- `error`・`ready` は state を更新しない（状態遷移ではなく通知）
- クライアント接続時に `snapshot` イベントとして Map の全値を1発送信 → 以後は live イベントを forward

これを **core に置かない**理由:

- core は CLI や他のフロントからも使われうる純粋観測層
- 「最新状態の map」は UI クライアント観点の需要であり、パーサ/監視の責務ではない
- server 層に閉じることで、スナップショットフォーマット変更が core に波及しない

### 4. **複数クライアントへの fan-out は server が行う**

core の `watchTodos()` は 1 サーバプロセスにつき **1 回だけ**起動する。server 内部で:

```
watcher.events ──► StateStore.apply() + EventBus.publish()
                                        │
                                        ├──► client A の SSE stream
                                        ├──► client B の SSE stream
                                        └──► client N の SSE stream
```

`EventBus` は subscriber ごとに独立したキューを持ち、publish 時に全員へ配る。これは watcher 実装の adversary 学習 (single-slot resolver の回避、return() でのクリーンアップ) を踏襲する。

### 5. **Coalescing は後回し**

同じ path に対する連続 upsert を畳む最適化は、実測で必要性を確認してから導入する。まずはナイーブに forward。

**導入する場合の方針（予約）**:

- path 単位で最新のみ保持・100ms ごとに flush
- `remove` と `error` は**即 flush**（状態遷移を失わないため）
- UI が「変更を検知した瞬間の視覚フィードバック」を必要としなくなったら有効

### 6. **SSE ワイヤフォーマット**

```
event: snapshot | upsert | remove | error | ready
data: <JSON>
```

- `snapshot`: `{ files: UpsertSnapshot[] }`
- `upsert`: `{ meta, path, items, mtimeMs }`
- `remove`: `{ meta, path }`
- `error`: `{ path, reason, message }` — Error オブジェクトの message 文字列のみ送る（スタックトレースは送らない）
- `ready`: `{}` — watcher の初期スキャン完了通知（subscribe 後に一度だけ）

`UpsertSnapshot` は wire 形式:
```ts
{ meta: { sessionId, agentId, isSubagent }, path, items: TodoItem[], mtimeMs }
```

## Consequences

### 良いこと

- core と server の責務が明確に分離され、core を別フロント（CLI）から再利用できる
- server が state を持つので新規クライアントが過去状態を即受け取れる
- UI 側実装は `EventSource` + `addEventListener('upsert', ...)` だけで十分シンプル
- 命令系を将来追加するときに SSE を壊さずに済む
- watcher の single-consumer / unbounded buffer 問題が server 層の fan-out 設計で解決

### 悪いこと（受け入れるコスト）

- server はメモリに全 todo ファイル最新状態を保持し続ける。Claude Code の todo ファイル総数は数百オーダで問題にならないが、無限には増やせない（`~/.claude/todos/` の総数に比例）
- fan-out バス・state store・SSE シリアライザと、「ただ流すだけ」にしては実装量がそこそこある。ただし coalescing を入れる将来タスクで同じバスが使える
- Coalescing を入れないうちは、活発なセッションで同じファイルの upsert が連続して流れる → UI 再描画コストは無視できないはず（後で観測して判断）

### 代替案として却下

- **core に broadcast を足す**: 責務違反。複数の client ごとの queue を core が持つのは「UI-agnostic」に矛盾
- **WebSocket**: 双方向性は今不要。実装複雑度と CDN/proxy 互換性の代償が引き合わない
- **SSE を双方向化（EventSource からの逆チャネル）**: そもそも SSE 規格は片方向。無理に双方向化するなら WebSocket を選ぶ方が筋
- **Coalescing を最初から入れる**: 流量と UI コストの実測がないまま最適化すると、設計パラメータ（window, key strategy）を根拠なく決めてしまう
