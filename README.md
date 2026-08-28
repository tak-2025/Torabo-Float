# Torabo-Float

**A transparent, always-on-top floating overlay that shows which keys you're pressing on a torabo-tsuki keyboard — in real time.**

透過・最前面のフローティングウィンドウに、[torabo-tsuki](https://github.com/sekigon-gonnoc/zmk-keyboard-torabo-tsuki-lp)
キーボードの「いま押しているキー」と「アクティブレイヤー」をリアルタイム表示する
Windows 常駐アプリです（Tauri v2 + React）。配信・操作説明のデモ・多レイヤーキーマップの確認用。

**→ <https://tak-2025.github.io/Torabo-Float/>**
インストール不要、Chrome / Edge のデスクトップ版で開くだけで同じ盤面表示が動きます。

> ⚠️ 本プロジェクトは ZMK Project とは **提携・承認関係にありません**。
> torabo-tsuki（[sekigon-gonnoc](https://github.com/sekigon-gonnoc) 氏設計）向けの非公式ツールです。

---

## まずは Web 版を試すのが簡単です

インストール不要で、ブラウザだけで同じ盤面表示が動きます（上記の URL）。
開いて「接続」を押し、キーボードを選ぶだけです。詳しくは[Web 版](#web-版)を参照してください。
常駐アプリとして使いたい・背景を透過して最前面に置きたい場合は、以下のデスクトップ版を使います。

---

## 必要なもの

| | 内容 |
|---|---|
| キーボード | **torabo-tsuki**。central 側の FW に `torabo-live-feed` スニペットを含めてビルドしたもの |
| PC | **Windows 10 / 11** |
| 接続 | キーボードと **BLE でペアリング済み**であること（本アプリはネイティブ BLE を使用） |

FW のビルドがはじめての方は、ブラウザで開くだけの
**[firmware-builder](https://tak-2025.github.io/torabo-tsuki_ext_FW/)** を使うと、
必要なスニペットを含む設定ファイルを自動生成できます。手順は
[torabo-tsuki_ext_FW の README](https://github.com/tak-2025/torabo-tsuki_ext_FW) にあります。

---

## 使い方

1. アプリを起動すると、**透過・最前面・枠なし**の小さなフロートウィンドウが出ます。
2. **スキャン** を押し、一覧から自分のキーボードを選んで **接続**。
3. 接続すると**キーマップを自動で同期**し（初回は数秒かかります）、そのまま盤面が表示されます。
   同期した内容はローカルに保存されるので、次回以降はすぐ表示されます。
4. あとはキーを打つだけです。押したキーがハイライトされ、レイヤーを切り替えると
   ウィンドウ左上のレイヤー名と刻印がそのレイヤーのものに変わります。
5. ウィンドウは**ヘッダー部分をドラッグ**して好きな位置へ移動、右上の **×** で終了します。

### ヘッダーのボタン

| ボタン | はたらき |
|---|---|
| **ログ** / **ボード** | 盤面表示と、受信イベントのログ表示を切り替える |
| **診断** | キーボード側の状態をライブ表示する診断ビュー（うまく動かないときに使う） |
| **同期** | キーマップを手動で取り直す |
| **切断** | キーボードとの接続を切る |
| **⚙** | 表示設定を開く（下記） |
| **×** | 終了 |

### 表示設定（⚙）

| 項目 | 内容 |
|---|---|
| **不透明度** | 30〜100%。配信で背景を透かしたいときに下げる |
| **刻印** | **US** / **JIS**。キーに描く刻印の並びを選ぶ |
| **テーマ** | 淡色 / ダーク / さくら / ミント / ハイコントラストの5色 |
| **サイズ** | **自動**（ウィンドウに合わせる）または **手動**（50〜200%、ウィンドウが盤面に合わせて自動リサイズ） |

設定は保存されるので、次に起動したときもそのままです。

### キーマップを変更したとき

Torabo-Studio などでキーマップを編集すると、アプリが変更を検知して
「キーマップが変更されています — 再同期してください」というバナーを出します。
**再同期** を押せば最新の内容に更新されます。

> BLE の GATT セッションは OS レベルで共有されるため、**Torabo-Studio と同時に起動できます**。
> また、ライブ表示は NOTIFY だけで成立するので、**キーボードがロック中でも動作**します。

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
実機の Chrome で動作確認しています。外部への通信は発生せず、`localStorage` も
機能するのでキーマップは一度読み込めば次回以降そのまま使えます。帰属表記（NOTICE）は
ファイル内に埋め込み済みなので、**この 1 枚をそのまま人に渡せます**。

### デスクトップ版との違い

| | デスクトップ版 | Web 版 |
|---|---|---|
| インストール | 必要 | 不要（URL / HTML 1 枚） |
| BLE | ネイティブ（`bluest`） | Web Bluetooth（Chrome / Edge のみ） |
| 背景の透過・最前面 | ✅ ネイティブウィンドウ | OBS のブラウザソース、または Document PiP（不透明） |
| 再接続 | 自動 | ページを開くたびにデバイス選択が必要 |

セットアップ・OBS 設定・既知の制約は [`web/README.md`](web/README.md) を参照してください。

---

## 仕組み

キー押下もレイヤー変更も **キーボードの central だけが知っている**情報です。ZMK Studio の RPC には
これらの通知が存在しないため、専用の GATT NOTIFY を出す FW モジュールを介して受け取ります。

```text
torabo-tsuki (central)
  └─ live_feed FW モジュール（カスタム GATT サービス e1f4af00 / char e1f4af01）
       │  キー押下・レイヤー変更・SNAPSHOT を 16 バイトの packed イベントで NOTIFY
       ▼  BLE
Torabo-Float アプリ
  ├─ src-tauri (Rust / bluest)   e1f4af01 を subscribe → Tauri event "live_feed_event"
  └─ React                        16B をデコードして押下キー・アクティブレイヤーを表示
```

- ライブ表示は **live_feed の NOTIFY のみ**で成立し、RPC には依存しません。
- キーマップと物理レイアウトは、接続時に ZMK Studio RPC で同期してローカルにキャッシュします。

イベントは 16 バイトの packed 構造体（`proto_ver` / `evt_type` / `position` / `pressed` / `source` /
`highest_layer` / `active_layout` / `layer_mask` / `keymap_crc`、リトルエンディアン）です。

---

## 開発・ビルド

**ビルド済みバイナリは配布していません。** デスクトップ版が必要な方はご自身でビルドしてください。
Node.js と Rust ツールチェーン（Tauri 用）が必要です。

```bash
npm install

# デスクトップアプリ（開発）
npm run tauri dev

# デスクトップアプリ（配布ビルド）
npm run tauri build
```

Web 版は `web/` に独立した npm プロジェクトとして入っています（Rust 不要）。

```bash
cd web
npm ci --ignore-scripts   # postinstall は失敗するので必ず付ける（web/README.md 参照）

npm run dev               # 開発サーバー（http://localhost:5178）
npm run build             # dist/ — Pages で配信するサイト
npm run build:single      # dist-single/index.html — 単一 HTML（ダウンロード用）
```

公開は [`.github/workflows/pages.yml`](.github/workflows/pages.yml) が `web/` への push で
自動実行します。

---

## 関連プロジェクト

- **[torabo-tsuki](https://github.com/sekigon-gonnoc/zmk-keyboard-torabo-tsuki-lp)** — sekigon-gonnoc 氏設計のキーボード本体（上流・GPL-3.0）
- **[torabo-tsuki_ext_FW](https://github.com/tak-2025/torabo-tsuki_ext_FW)** — 本アプリと対になる拡張 FW モジュール（`live_feed` を含む）
- **[Torabo-Studio](https://github.com/tak-2025/Torabo-Studio)** — torabo-tsuki 向けに機能拡張した [ZMK Studio](https://github.com/zmkfirmware/zmk-studio) の非公式フォーク（キーマップ編集・ライブ設定）
- **[ZMK Firmware](https://zmk.dev/)** / **[ZMK Studio](https://github.com/zmkfirmware/zmk-studio)** — 土台となるファームウェア／設定アプリ（本アプリは Studio の BLE transport 実装を流用しています）

---

## ライセンス

**Apache License 2.0**（[LICENSE](LICENSE)）。

本アプリは ZMK Studio および Torabo-Studio（ZMK Studio の非公式フォーク）由来のコード
（ネイティブ BLE transport など）を含むため、Apache-2.0 第4条に従いその帰属表記を
[NOTICE](NOTICE) に保持して同梱しています。本プロジェクトは ZMK Project とは提携・承認関係に
ない非公式ツールです。再配布の際は LICENSE と NOTICE を必ず同梱してください。
