# Torabo-Float

**A transparent, always-on-top floating overlay that shows which keys you're pressing on a torabo-tsuki keyboard — in real time.**

透過・最前面のフローティングウィンドウに、[torabo-tsuki](https://github.com/sekigon-gonnoc/zmk-keyboard-torabo-tsuki-lp)
キーボードの「いま押しているキー」と「アクティブレイヤー」をリアルタイム表示する
Windows 常駐アプリです（Tauri v2 + React）。配信・操作説明のデモ・多レイヤーキーマップの確認用。

> ⚠️ 本プロジェクトは ZMK Project とは **提携・承認関係にありません**。
> torabo-tsuki（[sekigon-gonnoc](https://github.com/sekigon-gonnoc) 氏設計）向けの非公式ツールです。

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
