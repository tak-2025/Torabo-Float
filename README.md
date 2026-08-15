# Torabo-Float

**A transparent, always-on-top floating overlay that shows which keys you're pressing on a torabo-tsuki keyboard — in real time.**

透過・最前面のフローティングウィンドウに、[torabo-tsuki](https://github.com/sekigon-gonnoc/zmk-keyboard-torabo-tsuki-lp)
キーボードの「いま押しているキー」と「アクティブレイヤー」をリアルタイム表示する
Windows 常駐アプリです（Tauri v2 + React）。配信・操作説明のデモ・多レイヤーキーマップの確認用。

> ⚠️ 本プロジェクトは ZMK Project とは **提携・承認関係にありません**。
> torabo-tsuki（[sekigon-gonnoc](https://github.com/sekigon-gonnoc) 氏設計）向けの非公式ツールです。
>
> 💡 **インストールせずに試せる [Web 版](#web-版)があります** →
> <https://tak-2025.github.io/Torabo-Float/>（Chrome / Edge のデスクトップ版）

---

## 仕組み

キー押下もレイヤー変更も **キーボードの central だけが知っている**情報です。ZMK Studio の RPC には
これらの通知が存在しないため、専用の GATT NOTIFY を出す FW モジュールを介して受け取ります。

```
torabo-tsuki (central)
  └─ live_feed FW モジュール（カスタム GATT サービス e1f4af00 / char e1f4af01）
       │  キー押下・レイヤー変更・SNAPSHOT を 16 バイトの packed イベントで NOTIFY
       ▼  BLE
Torabo-Float アプリ
  ├─ src-tauri (Rust / bluest)   e1f4af01 を subscribe → Tauri event "live_feed_event"
  └─ React                        16B をデコードして押下キー・アクティブレイヤーを表示
```

- ライブ表示は **live_feed の NOTIFY のみ**で成立し、RPC には依存しません（キーボードがロック中でも動作）。
- キーマップ／物理レイアウトは、初回に ZMK Studio RPC で一度だけ同期してローカルキャッシュする予定です（段階3・未実装）。
- BLE GATT セッションは OS レベルで共有されるため、**Torabo Studio と同時起動できます**。

イベントは 16 バイトの packed 構造体（`proto_ver` / `evt_type` / `position` / `pressed` / `source` /
`highest_layer` / `active_layout` / `layer_mask` / `keymap_crc`、リトルエンディアン）です。

---

## 必要なもの

- **torabo-tsuki キーボード** — central FW に `torabo-tsuki_ext_FW` の `torabo-live-feed` スニペットを含めてビルドしたもの
- **Windows 10 / 11**
- **ペアリング済みの BLE 接続**（本アプリはネイティブ BLE = `bluest` を使用）
- 開発時: **Node.js** と **Rust ツールチェーン**（Tauri 用）

---

## 開発状況

現段階は **デバッグビューのみ**で、キーキャップの描画（物理レイアウト上での押下ハイライト）はまだありません。

| 段階 | 内容 | 状態 |
|---|---|---|
| 段階1 | FW: `live_feed` モジュール（GATT NOTIFY + CCC） | ✅ 完了 |
| 段階2 | アプリ骨格 + 透過・最前面ウィンドウ + デバッグ表示 | ✅ 完了 |
| 段階3 | キーマップ同期（RPC）＋ ローカルキャッシュ | ⬜ 未着手 |
| 段階4 | 物理レイアウト描画 + 押下ハイライト + レイヤー追従ラベル | ⬜ 未着手 |
| 段階5 | 磨き込み（クリックスルー / システムトレイ / 設定永続化） | ⬜ 未着手 |

---

## 開発・ビルド

```bash
npm install

# デスクトップアプリ（開発）
npm run tauri dev

# デスクトップアプリ（配布ビルド）
npm run tauri build
```

Rust ツールチェーンと Node.js が必要です。

Web 版は `web/` に独立した npm プロジェクトとして入っています（Rust 不要）。

```bash
cd web
npm ci --ignore-scripts   # postinstall は失敗するので必ず付ける（web/README.md 参照）

npm run dev               # 開発サーバー（http://localhost:5178）
npm run build             # dist/ — Pages で配信するサイト
npm run build:single      # dist-single/index.html — 単一 HTML（ダウンロード用）
```

---

## 使い方（現状）

1. アプリを起動すると、透過・最前面・枠なしの小さなフロートウィンドウが出ます。
2. **スキャン** → 対象デバイスを選んで **接続**。
3. 接続後はデバッグパネルが表示されます:
   - **layer id / mask / layout / crc** バッジ（アクティブレイヤー状態）
   - **押下** 行に、いま押しているキーの position 番号
   - イベントログ（KEY / LAYER / SNAPSHOT の受信履歴）
4. ウィンドウはヘッダ部分をドラッグして移動、右上の **×** で終了します。

---

## Web 版

同じ盤面表示を**ブラウザで**動かす実装が [`web/`](web/) にあります（Web Bluetooth 使用）。
デスクトップ版とソース（live_feed デコーダ・盤面描画・キャッシュ形式・スタイルシート）を
共有していて、ネイティブ BLE（Rust / `bluest`）の部分だけが Web Bluetooth に差し替わっています。

| 用途 | URL |
|---|---|
| サイト | <https://tak-2025.github.io/Torabo-Float/> |
| OBS のブラウザソース | <https://tak-2025.github.io/Torabo-Float/?chrome=0> |
| 単一 HTML | <https://tak-2025.github.io/Torabo-Float/torabo-float-web.html> |

### ダウンロードしてローカルで使えます

サイト全体を **HTML ファイル 1 枚**に固めたビルドを同じ場所に置いてあります。
JS も CSS も中に埋め込んであるので、上の「単一 HTML」を**落としてダブルクリックするだけ**で、
サイトと同じものがそのまま動きます。**サーバも Node.js もインストールも不要**です。

`file://` のまま Web Bluetooth でキーボードとペアリングし、GATT 接続してライブ表示するところまで
**実機の Chrome で動作確認済み**です（2026-08-09）。外部への通信は発生せず、`localStorage` も
機能するのでキーマップは一度読み込めば次回以降そのまま使えます。帰属表記（NOTICE）は
ファイル内に埋め込み済みなので、**この 1 枚をそのまま人に渡せます**。

### デスクトップ版との違い

| | デスクトップ版 | Web 版 |
|---|---|---|
| インストール | 必要 | 不要（URL / HTML 1 枚） |
| BLE | ネイティブ（`bluest`） | Web Bluetooth（Chrome / Edge のみ） |
| 背景の透過・最前面 | ✅ ネイティブウィンドウ | OBS のブラウザソース、または Document PiP（不透明） |
| 再接続 | 自動 | ページを開くたびにデバイス選択が必要 |

公開は [`.github/workflows/pages.yml`](.github/workflows/pages.yml) が `web/` への push で
自動実行します。セットアップ・OBS 設定・既知の制約は [`web/README.md`](web/README.md) を参照してください。

---

## 関連プロジェクト

- **[torabo-tsuki](https://github.com/sekigon-gonnoc/zmk-keyboard-torabo-tsuki-lp)** — sekigon-gonnoc 氏設計のキーボード本体（上流・GPL-3.0）
- **[torabo-tsuki_ext_FW](https://github.com/tak-2025/torabo-tsuki_ext_FW)** — 本アプリと対になる拡張 FW モジュール（`live_feed` を含む）
- **Torabo-Studio** — torabo-tsuki 向けに機能拡張した [ZMK Studio](https://github.com/zmkfirmware/zmk-studio) の非公式フォーク（キーマップ編集・ライブ設定）
- **[ZMK Firmware](https://zmk.dev/)** / **[ZMK Studio](https://github.com/zmkfirmware/zmk-studio)** — 土台となるファームウェア／設定アプリ（本アプリは Studio の BLE transport 実装を流用しています）

---

## ライセンス

**Apache License 2.0**（[LICENSE](LICENSE)）。

本アプリは ZMK Studio および Torabo-Studio（ZMK Studio の非公式フォーク）由来のコード
（ネイティブ BLE transport など）を含むため、Apache-2.0 第4条に従いその帰属表記を
[NOTICE](NOTICE) に保持して同梱しています。本プロジェクトは ZMK Project とは提携・承認関係に
ない非公式ツールです。再配布の際は LICENSE と NOTICE を必ず同梱してください。
