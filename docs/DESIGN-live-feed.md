# DESIGN-live-feed — ライブフィードの受信

Status: 実装済み・実機検証済み（BLE / USB 両経路）。ファームウェア側の実体は
[torabo-tsuki_ext_FW](https://github.com/tak-2025/torabo-tsuki_ext_FW) の `live_feed/` モジュール
（snippet `torabo-live-feed`）。

## なぜ RPC ではなく専用チャネルなのか

キー押下もレイヤー変更も **キーボードの central だけが知っている**情報です。ZMK Studio の RPC
にはこれらを通知する口が無いため、専用の GATT NOTIFY を出す FW モジュールを介して受け取ります。

この設計の効きどころは 2 つあります。

- **RPC に依存しない。** BLE ではライブ表示が NOTIFY だけで成立するので、キーボードが
  ロック中（Studio のロック状態）でも盤面は動きます。
- **購読していなければゼロコスト。** FW 側は誰も subscribe していないときは何も送りません。

## 採番

| 項目 | 値 |
|---|---|
| GATT service | `e1f4af00-1c2d-4b6e-9f3a-0a1b2c3d4e5f` |
| ライブフィード characteristic | `e1f4af01-…`（NOTIFY + READ、ENCRYPT） |
| 診断 characteristic | `e1f4af02-…`（NOTIFY + READ + WRITE、ENCRYPT） |
| ZMK Studio RPC service / char（キーマップ同期用） | `00000000-0196-6107-c967-c5cfb1c2482a` / `00000001-…` |
| トンネル feature id（USB 経路） | `0x0F` |

定義箇所は [`src-tauri/src/transport/live_feed.rs`](../src-tauri/src/transport/live_feed.rs) /
[`diag.rs`](../src-tauri/src/transport/diag.rs) / [`gatt.rs`](../src-tauri/src/transport/gatt.rs) と、
Web 版の [`web/src/ble.ts`](../web/src/ble.ts) 冒頭。**両方に同じ値が書いてあるので、変えるときは対で直すこと。**

## ワイヤ v1 — 16 バイト固定、リトルエンディアン

```text
 0  u8   proto_ver      = 1（不一致は破棄）
 1  u8   evt_type       1=KEY / 2=LAYER / 3=SNAPSHOT
 2  u16  position       KEY: グローバルなキーマップ位置 / LAYER・SNAPSHOT: 0xFFFF
 4  u8   pressed        KEY: 1=押下 0=解放
 5  u8   source         KEY: 0xFF=central 自身 / 0,1,… = peripheral のスロット
 6  u8   highest_layer  レイヤー ID（インデックスではない）
 7  u8   active_layout  選択中の物理レイアウトの index
 8  u32  layer_mask     ID を鍵にしたアクティブレイヤーのビットマスク
12  u32  keymap_crc     全レイヤー・全バインディングの CRC32
```

デコーダは [`shared/liveFeed.ts`](../shared/liveFeed.ts)（デスクトップ / Web 両ターゲット共通の単一ソース）。
`proto_ver` か `evt_type` が未知のもの、16 バイト未満のものは `null` を返して**黙って捨てます**
（前方互換：新しい FW が増やしたイベント種別で落ちないため）。

`keymap_crc` はキーマップ変更の検知に使います（[DESIGN-keymap.md](DESIGN-keymap.md)）。

## 2 つの経路

| | BLE | USB |
|---|---|---|
| 物理 | GATT NOTIFY | CDC-ACM の 1 本のバイトストリーム |
| ライブフィード | `e1f4af01` の NOTIFY | `torabo-rpc-tunnel` の notification（feature `0x0F`） |
| キーマップ同期 | RPC 用 characteristic（別チャネル） | 同じストリームに相乗り |
| FW 要件 | `torabo-live-feed` | `torabo-live-feed` ＋ `torabo-rpc-tunnel` |

USB 側は 1 本のストリームに全部載るため、[`serial.rs`](../src-tauri/src/transport/serial.rs) の
リーダースレッドが再組み立てしたフレームを種別で振り分けます。

- feature `0x0F` の `ToraboTunnelNotification` → **BLE と同じ Tauri イベントとして再送出**
- 自分が投げた要求への `ToraboTunnelResponse` → oneshot チャネルで待っている呼び出しへ
- それ以外 → `connection_data` としてそのまま webview の ZMK Studio ts-client へ

書き込み方向は 1 本の mutex で守り、トンネル要求が ts-client のフレームの途中に割り込まないようにしています。

## イベントの正規化

transport が何であれ、上位には**同じ 4 つのイベント**しか見せません。これが「UI 側が接続方式を
知らない」状態を支えています。

| イベント | 中身 |
|---|---|
| `live_feed_event` | 生の 16 バイトレコード |
| `live_feed_diag_event` | 診断レコード（`e1f4af02` 由来、USB ではトンネルの診断通知） |
| `connection_data` | ZMK Studio RPC の生バイト列（ts-client がデコードする） |
| `connection_disconnected` | 切断 |

デスクトップ版は Rust から Tauri の `emit` で、Web 版は [`web/src/events.ts`](../web/src/events.ts) の
自前エミッタで発火します。Web 側は Tauri の `listen()` と同じ契約（`on(name, handler)` が
unlisten を返す）をわざと真似ているので、購読側のコードが共有できます。

## 診断（`e1f4af02`）

トラックボール・トラックパッドなど FFC 接続モジュールの疎通確認用です。既定では何も流れず、
**購読・有効化したときだけ**発火します。UI は [`DiagPanel.tsx`](../src/DiagPanel.tsx)（デスクトップ版と
Web 版で同一）。

## 制約

- **central 専用。** peripheral 側の FW に載せても意味がありません。
- **Torabo Studio とは排他。** USB は COM ポートを 1 プロセスが専有し、BLE も 1 台のキーボードが
  同時に相手にできるアプリは 1 つです。回避策はありません（UI に明示しています）。
- USB でライブフィードを受けるには FW 側に `torabo-rpc-tunnel` が要ります。非対応 FW に USB で
  つなぐと `UNSUPPORTED_FEATURE` が返ります。
