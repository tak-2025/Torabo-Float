# Torabo-Float 設計ドキュメント

開発者向けの設計メモです。使い方は [../README.md](../README.md)、接続手順・OBS の設定は
Web 版のトップページ（<https://tak-2025.github.io/Torabo-Float/>）にあります。

## このリポジトリにあるもの

**同じ盤面表示アプリの実装が 2 つ**入っています。UI は同じソースを共有し、キーボードとの
通信経路（transport）だけが違います。

| | デスクトップ版 | Web 版 |
|---|---|---|
| 場所 | [`src/`](../src) + [`src-tauri/`](../src-tauri) | [`web/`](../web) |
| 土台 | Tauri v2（React + Rust） | Vite + React（Rust なし） |
| BLE | Rust の `bluest` | Web Bluetooth |
| USB | Rust の `serialport` | Web Serial |
| 透過・最前面 | ネイティブウィンドウ | 不可（Document PiP で最前面のみ） |
| キーマップ | RPC 同期 | RPC 同期 ＋ JSON インポート |

```text
torabo-tsuki (central)
  └─ ext_FW の live_feed モジュール
       │  キー押下・レイヤー変更・SNAPSHOT を 16 バイトの packed イベントで送出
       ▼  BLE: GATT NOTIFY (e1f4af01) / USB: torabo-rpc-tunnel の notification
  transport 層（Rust の src-tauri/src/transport/ ／ Web の ble.ts・serial.ts）
       │  どちらの経路でも同じ 4 つのイベントに正規化する
       ▼  live_feed_event / live_feed_diag_event / connection_data / connection_disconnected
  React（liveFeed.ts でデコード → FloatBoard が盤面を描画）
```

キーマップと物理レイアウトは live_feed には乗りません。別途 ZMK Studio RPC で同期して
ローカルにキャッシュします（[DESIGN-keymap.md](DESIGN-keymap.md)）。

## ドキュメント

| ドキュメント | 内容 |
|---|---|
| [DESIGN-live-feed.md](DESIGN-live-feed.md) | ライブフィードの受信仕様（GATT 採番・16 バイトワイヤ・USB トンネル・イベント正規化・診断） |
| [DESIGN-keymap.md](DESIGN-keymap.md) | キーマップと物理レイアウトの供給（RPC 同期・キャッシュ形式・JSON インポート・タイムアウト方針） |
| [DESIGN-web.md](DESIGN-web.md) | Web 版の設計（ソース共有の実態・transport 抽象・表示 3 方式・URL パラメータ） |
| [BUILD.md](BUILD.md) | ビルドと配布（npm スクリプト・`.npmrc`・単一 HTML・GitHub Pages） |

対になるファームウェア側の仕様は
[torabo-tsuki_ext_FW](https://github.com/tak-2025/torabo-tsuki_ext_FW) の `docs/` にあります。

## ソースの歩き方

| ファイル | 役割 |
|---|---|
| [`src/liveFeed.ts`](../src/liveFeed.ts) | 16 バイトレコードのデコーダ。**デスクトップ版と Web 版で完全に同一** |
| [`src/keyboard/FloatBoard.tsx`](../src/keyboard/FloatBoard.tsx) | 盤面の描画。同上 |
| [`src-tauri/src/transport/live_feed.rs`](../src-tauri/src/transport/live_feed.rs) | BLE の live_feed クライアント |
| [`src-tauri/src/transport/serial.rs`](../src-tauri/src/transport/serial.rs) | USB（CDC）側。トンネルの多重分離もここ |
| [`src-tauri/src/transport/tunnel.rs`](../src-tauri/src/transport/tunnel.rs) | Studio RPC のフレーミングと protobuf の手書きコーデック |
| [`web/src/link.ts`](../web/src/link.ts) | Web 版でどちらの transport が繋がっているかを持つ唯一の場所 |

各ファイルの冒頭コメントに、そのファイル固有の設計判断（なぜそう書いたか）が入っています。
ここの文書はその上のレイヤ — **複数ファイルにまたがる決めごと**だけを書きます。
