# Torabo-Float

**A transparent, always-on-top floating overlay that shows which keys you're pressing on a torabo-tsuki keyboard — in real time.**

透過・最前面のフローティングウィンドウに、[torabo-tsuki](https://github.com/sekigon-gonnoc/torabo-tsuki-lp)
キーボードの「いま押しているキー」と「アクティブレイヤー」をリアルタイム表示する
Windows 向けの透過フロートウィンドウアプリです（Tauri v2 + React）。配信・操作説明のデモ・多レイヤーキーマップの確認用。

**→ <https://tak-2025.github.io/Torabo-Float/>**
インストール不要。PC 版の Chrome / Edge で開いて「接続」を押すだけで、同じ盤面表示が動きます。
背景を透過して最前面のウィンドウとして置きたい場合は、下記のデスクトップ版を使います。

> ⚠️ 本プロジェクトは ZMK Project とは **提携・承認関係にありません**。
> torabo-tsuki（[sekigon-gonnoc](https://github.com/sekigon-gonnoc) 氏設計）向けの非公式ツールです。

---

## 必要なもの

拡張 FW が必要になります。
[torabo-tsuki_ext_FW の README](https://github.com/tak-2025/torabo-tsuki_ext_FW) を用いて、
ファームウェアを更新してください。

## 動作確認
**Windows 11**、**Chrome / Edge**

---

## 使い方

1. アプリを起動すると、**透過・最前面・枠なし**の小さなフロートウィンドウが出ます。
2. **BLE / USB** を選びます。USB ならケーブルで直結して **再検出** → COM ポートを選択、
   BLE なら **スキャン** を押して一覧から自分のキーボードを選びます。
3. **接続** を押します。
4. 接続すると**キーマップを自動で同期**し（初回は数秒かかります）、そのまま盤面が表示されます。
   同期した内容はローカルに保存されるので、次回以降はすぐ表示されます。
5. 押したキーがハイライトされ、レイヤーを切り替えると
   ウィンドウ左上のレイヤー名と刻印がそのレイヤーのものに変わります。
6. ウィンドウは**ヘッダー部分をドラッグ**して好きな位置へ移動できます。右上の **×** で終了します。

### ヘッダーのボタン

| ボタン | はたらき |
|---|---|
| **ログ** / **ボード** | 盤面表示と、受信イベントのログ表示切り替え |
| **診断** | トラックボール、トラックパッド等、FFC 接続のモジュールの動作確認 |
| **同期** | キーマップの更新 |
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

> **Torabo Studio とは同時に接続できません。** 切り替えるときは片方を閉じてください。（Torabo Floatを接続している状態で、他の端末に接続を切り替えることは可能です。他の端末でキー入力しつつ、Torabo Floatでキーボードのレイアウトを確認できます。

---

## Web 版

同じ盤面表示を**ブラウザで**動かすこともできます[`web/`](web/) にあります（Web Bluetooth / Web Serial 使用）。
ネイティブ transport（BLE は Rust の `bluest`、USB は `serialport`）の部分が
Web Bluetooth / Web Serial に差し替わっています。

| 用途 | URL |
|---|---|
| サイト | <https://tak-2025.github.io/Torabo-Float/> |
| OBS のブラウザソース | <https://tak-2025.github.io/Torabo-Float/?chrome=0> |
| 単一 HTML | <https://tak-2025.github.io/Torabo-Float/torabo-float-web.html> |

### ローカル使用

サイト全体を **HTML ファイル 1 枚**に固めたビルドを同じ場所に置いてあります。
JS も CSS も中に埋め込んであるので、上の「単一 HTML」を**落としてダブルクリックするだけ**で、
サイトと同じものがそのまま動きます。特にインストール不要です。

### デスクトップ版との違い

基本的な操作性は同じです。違いは、Web 版では**背景の透過とクリックスルーができない**こと、
**ページを開くたびにデバイス選択が必要**（自動再接続なし）なことです。逆に Web 版だけが
キーマップの JSON インポート／エクスポートに対応しています。
接続手順・OBS の設定・既知の制約は、Web 版のトップページ
（<https://tak-2025.github.io/Torabo-Float/>）に載せてあります。

## 開発・ビルド

**ビルド済みバイナリは配布していません。** デスクトップ版が必要な方はご自身でビルドしてください。
Node.js と Rust ツールチェーン（Tauri 用）が必要です。

```bash
npm install   # ルートの .npmrc（ignore-scripts=true）が付いているので追加フラグ不要

# デスクトップアプリ（開発）
npm run tauri dev

# デスクトップアプリ（配布ビルド）
npm run tauri build
```

Web 版は `web/` に独立した npm プロジェクトとして入っています（Rust 不要）。

```bash
cd web
npm ci --ignore-scripts   # web/.npmrc も同じ設定だが、CI と同様に明示

npm run dev               # 開発サーバー（http://localhost:5178）
npm run build             # dist/ — Pages で配信するサイト
npm run build:single      # dist-single/index.html — 単一 HTML（ダウンロード用）
```

公開は [`.github/workflows/pages.yml`](.github/workflows/pages.yml) が `web/` への push で
自動実行します。ビルドと配布の詳細は [`docs/BUILD.md`](docs/BUILD.md) を参照してください。

---

## ドキュメント

開発者向けの設計メモは [`docs/`](docs/) にあります。

- [`docs/DESIGN-live-feed.md`](docs/DESIGN-live-feed.md) — ライブフィードの受信仕様
  （GATT 採番・16 バイトワイヤ・USB トンネル・イベント正規化）
- [`docs/DESIGN-keymap.md`](docs/DESIGN-keymap.md) — キーマップと物理レイアウトの供給
  （RPC 同期・キャッシュ形式・JSON インポート）
- [`docs/DESIGN-web.md`](docs/DESIGN-web.md) — Web 版の設計（ソース共有・表示 3 方式・URL パラメータ）
- [`docs/BUILD.md`](docs/BUILD.md) — ビルドと配布

---

## 関連プロジェクト

- **[torabo-fun](https://tak-2025.github.io/torabo-fun/)** — torabo-tsuki 拡張プロジェクト群の紹介ポータル
- **[torabo-tsuki](https://github.com/sekigon-gonnoc/torabo-tsuki-lp)** — sekigon-gonnoc 氏設計のキーボード本体（上流・GPL-3.0）
- **[torabo-tsuki_ext_FW](https://github.com/tak-2025/torabo-tsuki_ext_FW)** — 本アプリと対になる拡張 FW モジュール（`live_feed` / `torabo-rpc-tunnel` を含む）
- **[Torabo Studio](https://github.com/tak-2025/Torabo-Studio)** — torabo-tsuki 向けに機能拡張した [ZMK Studio](https://github.com/zmkfirmware/zmk-studio) の非公式フォーク（キーマップ編集・ライブ設定）
- **[ZMK Firmware](https://zmk.dev/)** / **[ZMK Studio](https://github.com/zmkfirmware/zmk-studio)** — 土台となるファームウェア／設定アプリ（本アプリは Studio の BLE / USB transport 実装を流用しています）

---

## ライセンス

**Apache License 2.0**（[LICENSE](LICENSE)）。

本アプリは ZMK Studio および Torabo Studio（ZMK Studio の非公式フォーク）由来のコード
（ネイティブ BLE / USB transport など）を含むため、Apache-2.0 第4条に従いその帰属表記を
[NOTICE](NOTICE) に保持して同梱しています。本プロジェクトは ZMK Project とは提携・承認関係に
ない非公式ツールです。
