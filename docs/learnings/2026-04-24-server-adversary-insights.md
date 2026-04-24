# Hono + SSE server の Adversary レビューで浮いた設計知見

- **Date**: 2026-04-24
- **Context**: `@task-viewer/server` 初期実装への adversary レビュー。ADR-0002 で凍結した SSE / server-owned fan-out の実装面で、pump ループ・sub race・リソース解放・CORS まで広めに当たった。

## 1. スナップショットを書いたあとに subscribe すると **events が迷子になる**

最初の実装は `writeSSE(snapshot) → bus.subscribe()` の順だった。これは
**snapshot を書いた直後 (await 点で event loop が譲る) から subscribe 完了までの間**
に watcher が新しい event を pump すると、state は更新される一方で
subscriber は 0 件なので bus.publish が silently drop される事故が発生する。

新規クライアントの snapshot には入っておらず、次の change を待つしかない。
**変更を見逃す観測ツールは存在価値が半減する**。

**対策**: **subscribe 先、snapshot 後**に並び替える。snapshot 送信中に
publish が来ても subscribe 済みなのでバッファに入り、後続の for-await で
吸える。path-keyed state なので重複配信は冪等 (同じ path の upsert が
来ても UI 側は最新で上書きするだけ)。

**教訓**: **snapshot 型のライフサイクルでは必ず subscribe を先に取れ**。
「漏れる」より「重複する」の方が情報理論的に扱いやすい (重複は idempotent
state で吸える、漏れは不可逆)。

## 2. **ADR で後回し宣言した責務は follow-up を必ず作る**

ADR-0002 §5 で「coalescing は後回し」と明記した。同じ ADR §4 で
「backpressure は server 層の責務」とも明記した。
しかし初期実装では server 層に **何の backpressure も実装されていなかった**
(bus の per-subscriber queue が無制限)。

ADR で deferred と書いた時点で「いつか実装する」ではなく、
**「現時点での穴」として明示的に記載する**必要がある。
adversary レビューは ADR と実装の不整合を鋭く突いてくる。

**対策**: 最低限の drop-oldest policy を EventBus に入れた。
(`maxBufferSize`, default 10000。超えたら shift で先頭捨て。)
不十分だが「OOM しない」は保証される。本格的な per-path coalescing は
次の ADR で別立てで設計する。

**教訓**: ADR の「defer する」項目は次のタスクの DoD に入れるか、
implementation ノートとして残して実装側でコメントで TODO を明示する。

## 3. 長命 pump の失敗は **log-and-walk-away してはいけない**

```ts
pump.catch((err) => console.error(err));  // 最初の実装
```

これは watcher が死んだあと server が**ゾンビ化**する。
SSE クライアントはつながったまま永遠にイベントを待ち、
`EventSource` の auto-reconnect も発火しない (接続が切れていないから)。

**対策**: pump の catch で:
1. エラー内容を `bus.publish({ kind: 'error', ... })` で流す
2. `bus.closeAll()` で全 SSE stream を終了させる

これでブラウザの `EventSource` が `onerror` を発火して reconnect に入る。

**教訓**: **長命な async loop の error handler は "通知 + 伝播停止" の
両方をやる**。log だけでは何も救済されない。

## 4. Node の listening callback Promise は **error listener と組で使え**

```ts
const server = await new Promise<ServerType>((resolve) => {
  const s = serve({ ... }, () => resolve(s));  // 失敗時 resolve されない
});
```

これは EADDRINUSE でも何でも**永遠に pending** のまま。
`main.ts` の `await startServer()` も刺さる。
しかも pump は先に動いているので watcher がスピンし続ける。

**対策**:

```ts
await new Promise<ServerType>((resolve, reject) => {
  const s = serve({ ... }, () => resolve(s));
  s.on('error', reject);
});
```

加えて **catch で watcher.stop() + bus.closeAll()** で部分リソースを片付ける。

**教訓**: ライブラリが callback で「listen success」だけくれるパターンは、
**必ず server instance の `error` イベントとペアにして Promise を組む**。
片方だけだと確実に hang する。

## 5. localhost でも `cors()` wildcard は **browser tab 経由の exfil 経路**

ダッシュボード用 localhost サーバは「外から叩けないから安全」が油断ポイント。
`Access-Control-Allow-Origin: *` のままだと、**ユーザーが開いている別タブ
の任意の Web ページ**が fetch('http://127.0.0.1:4321/events') で SSE を
購読できる。todo の中身 (タスク名・cwd・git branch) が漏れる。

**対策**: 明示的 allowlist (`http://localhost:5173`, `http://127.0.0.1:5173`)。
デフォルトで絞り、`corsOrigin` オプションで拡張可能に。

**教訓**: localhost bind = ネットワーク到達性の制限であって、
**browser origin 境界の制限にはならない**。両方絞る。

## 6. アイドル SSE には **retry + heartbeat** を送っておくと静かな切断に強い

何も流れない時間が続くと、NAT / corporate proxy / tab sleeping が
TCP を切ることがある。browser の `EventSource` は自動再接続するが:

- `retry:` ヒントを送っていないと `3000ms` 固定 (規格デフォルト) で、
  負荷ピーク時に一斉再接続で thundering herd
- heartbeat (SSE コメント `: ping\n\n`) を定期送信しておくと
  proxy idle timeout が走らず、切断自体を減らせる

**対策**: 接続直後に `retry: 3000` を snapshot と同じ block に同梱し、
20秒に1回 `: heartbeat\n\n` をコメントで流す。
tests は 20秒より早く終わるので heartbeat に干渉しない。
テスト時は `heartbeatMs: 0` で無効化できるように option 化。

**教訓**: SSE は「一度つなげば黙って流れる」で終わらない。
**retry ヒントと heartbeat は pair でデフォルト有効にする**。

## 7. `Set` を iterate 中に同期的 unsubscribe される可能性を潰しておく

```ts
for (const sub of this.subs) {        // 最初の実装
  const r = sub.pendingResolves.shift();
  if (r) r({ value: ev, done: false }); // この resolver が別の sub を unsubscribe したら…
}
```

V8 の Set iteration は mid-iteration delete に寛容だが、**依存するのは
undocumented invariant**。onAbort が publish 中に発火すると理論上
起こりうる。

**対策**:

```ts
for (const sub of Array.from(this.subs)) { ... }
```

**教訓**: **fan-out ループは常に iterate target を snapshot してから回す**。
O(N) コストは微々たるもので、安全性の方がずっと価値が高い。

## まとめ

adversary が1回のレビューで見つけた critical/important 合計 9件のうち、
6件が「ライフサイクルと resource cleanup の落とし穴」、3件が「security
/ protocol の省略」だった。AsyncIterable / pump / long-lived server は
それぞれ別の cleanup 契約を持っており、個別に書くと抜ける。
**前タスクの watcher 学習で同じ類のパターンを踏んでいたのに、
server の pump で同じ過ちを再演した** のが本日の反省点。
