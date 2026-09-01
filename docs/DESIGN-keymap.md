# DESIGN-keymap — キーマップと物理レイアウトの供給

Status: 実装済み。デスクトップ版・Web 版で**キャッシュ形式は共通**（`CACHE_VERSION = 2`）、
保存先と取得経路だけが違います。

## 何が要るのか

盤面を描くには 2 つが必要です。

1. **物理レイアウト** — キーの並び（位置・回転・サイズ）
2. **キーマップ** — 各レイヤーの各キーに何が割り当たっているか＋ behavior のメタ情報

ライブフィード（[DESIGN-live-feed.md](DESIGN-live-feed.md)）が運ぶのは「どの位置がいま押された
／どのレイヤーが有効か」だけで、**上の 2 つは一切乗りません**。別経路で取得してキャッシュします。

## 経路A: ZMK Studio RPC 同期

接続時に ts-client 経由で `getKeymap` / `listAllBehaviors` / `getBehaviorDetails` などを呼び、
結果をキャッシュへ書きます（[`keymap/sync.ts`](../src/keymap/sync.ts)）。

- **BLE** — デスクトップ版はネイティブ BLE、Web 版は RPC 用 GATT characteristic。
- **USB** — CDC の 1 本のストリームに RPC が乗ります（`torabo-rpc-tunnel` 必須）。

初回だけ数秒〜（環境により長く）かかり、以降はキャッシュから即座に描画します。

### タイムアウト方針がデスクトップ版と Web 版で違う

| | デスクトップ版 | Web 版 |
|---|---|---|
| 方式 | **固定デッドライン** 4 秒 | **アイドルタイムアウト** 15 秒＋絶対上限 120 秒 |
| 実装 | [`src/rpc/logging.ts`](../src/rpc/logging.ts) | [`web/src/rpc/logging.ts`](../web/src/rpc/logging.ts) |

理由：ZMK は RPC characteristic を **INDICATE** で提供するため、`getKeymap` のような数 KB の
応答は 1 往復あたり約 20 バイトずつしか進みません。ネイティブ BLE スタックで調整した 4 秒の
デッドラインをブラウザに持ち込むと、**小さい呼び出しは通るのに大きい呼び出しだけが必ず落ちる**
という症状になります。そこで Web 版は「無音が続いたら失敗」に変え、受信バイトが届くたびに
タイマーを張り直します。120 秒の上限は、バイトは届き続けるのにフレームが完成しない病的なケース用の
バックストップです。

同期の進捗と、完了後の所要時間の内訳（レイアウト／キーマップ／ビヘイビア）は画面に表示します。
遅い環境でどの段で待たされているかを利用者が言えるようにするためです。

### 同期に失敗しても致命傷にしない

失敗しても通知が出るだけで、**ライブ表示（キー押下・レイヤー）はそのまま動きます**。盤面の
描画だけがキャッシュ待ちになります。

## 経路B: JSON インポート（Web 版のみ）

[`web/src/keymap/import.ts`](../web/src/keymap/import.ts)。**RPC がうまくいかないときの確実な経路**で、
トップレベルのキーで 2 つの形式を判別します。

| ファイル | 出どころ | 中身 |
|---|---|---|
| Torabo-Float キャッシュ（`version`） | 本アプリのエクスポート、またはデスクトップ版の `%APPDATA%/io.github.tak-2025.torabo-float/keymap-cache.json` | 物理レイアウト＋レイヤー＋ behavior 表。**完全** |
| torabo-tsuki バックアップ（`format: "torabo-tsuki-backup"`） | Torabo Studio の「バックアップ」パネル | キーマップと（v4 以降）behaviorId → 表示名の対応表。**物理レイアウトを含まない** |

バックアップ形式には geometry が無いので、ブラウザのキャッシュにある物理レイアウト、無ければ
同梱の torabo-tsuki の geometry を使って変換します。

> **behaviorId について。** ZMK は behavior の ID を機体ごとに採番するため、バックアップ内の ID は
> それを書き出した個体でしか意味を持ちません。**別の機体への復元**ではこれが問題になりますが、
> 本アプリは読むだけなので影響しません（v4 の名前表があればそちらを使います）。

## キャッシュ

| | デスクトップ版 | Web 版 |
|---|---|---|
| 保存先 | `<app_data_dir>/keymap-cache.json`（`io.github.tak-2025.torabo-float`） | `localStorage["torabo-float-keymap-cache"]` |
| 実装 | [`src-tauri/src/transport/cache.rs`](../src-tauri/src/transport/cache.rs) | [`web/src/keymap/cache.ts`](../web/src/keymap/cache.ts) |
| サイズ | torabo-tsuki 1 台ぶんで JSON 約 30 KB |

**スキーマは共通**なので、デスクトップ版が書いたファイルを Web 版へそのまま読ませられます
（それが経路B のいちばん確実な入力です）。

### バージョン

- `CACHE_VERSION = 2` — behavior のパラメータメタ情報を持つ。盤面がバインディングの中身を
  正しく描くのに必要（[`keyboard/binding-face.ts`](../src/keyboard/binding-face.ts)）。
- **v1 のキャッシュも読みます。** メタ情報が無いので param1 を描く v2 以前の挙動に落ちるだけで、
  次の同期で埋まります。ここを「古いから捨てる」にすると、キャッシュが null → 接続時に自動同期 →
  ブラウザ BLE では数分かかる、という最悪の経路に落ちるため、**読めるものは読む**方針です。

## キーマップ変更の検知

ライブフィードの `keymap_crc` とキャッシュの CRC を比較し、食い違ったら
「キーマップが変更されています — 再同期してください」を出します（`App.tsx`）。Torabo Studio で
キーマップを編集したあと、盤面が古いまま黙って表示され続けるのを防ぐためです。
