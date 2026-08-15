# Torabo-Float-Web — 設計メモ

作成 2026-08-07 / 同日更新（説明ページ・表示方法 3 種・実機検証結果を反映）。
ユーザー確定事項と、実装で下した判断・未検証事項の記録。

---

## 1. 何を作ったか / 作らないか

- **作る**: Float 盤面のライブ表示（キー押下・アクティブレイヤー）の Web 版。
- **作らない**: キーマップ編集。表示専用。
- **用途**:
  1. OBS のブラウザソースで背景透過オーバーレイ
  2. 他人に URL を渡して使ってもらう
- **ライセンス**: Apache-2.0（Torabo-Float / zmk-studio 由来）。LICENSE + NOTICE 同梱必須。
- **リポジトリ**: 新規 Private 予定。現時点ではローカル git のみ（GitHub 未作成 / push なし）。
  将来 GitHub Pages 公開の可能性があるため `vite.config.ts` の `base` は `"./"`（相対パス）。

---

## 2. Torabo-Float との関係

**同じソースを持つ 2 つのシェル**という関係。デスクトップ版が正、Web 版が従。

`Torabo-Float/src` は 18 ファイル。うち **12 ファイルは Tauri 非依存の純 React/TS** で、
本リポジトリへ **無改修コピー**した（先頭コメントも含め 1 バイトも変えていない）。
将来の同期を容易にするため、この 12 ファイルは常に `diff` が空であるべき。

### 無改修コピー（12 + データ 3）

```
src/DiagPanel.tsx
src/diag.ts
src/hid-usages.ts
src/liveFeed.ts
src/main.tsx
src/keyboard/FloatBoard.tsx
src/keyboard/Key.tsx
src/keyboard/HidUsageLabel.tsx
src/keyboard/PhysicalLayout.tsx
src/keyboard/legends.ts
src/keymap/sync.ts
src/rpc/logging.ts
（＋ JSON データ: hid-usage-name-overrides / keyboard-and-consumer-usage-tables /
   keyboard/behavior-short-names）
```

`src/styles.css` も**上半分は完全コピー**で、末尾に
`/* ===== Web build additions ===== */` 以下の追記ブロックだけを足している。
テーマ5種（pale / dark / sakura / mint / contrast）と JIS/US 刻印はここに丸ごと入っている。
**Tailwind は不採用**（Float と同じ plain CSS + CSS 変数）。

### 書き換えたファイル（6）

| ファイル | Float（Tauri） | Web |
|---|---|---|
| `src/ble.ts` | `invoke()` ラッパー | **Web Bluetooth API**（本タスクの核心） |
| `src/hooks/useLiveFeed.ts` | `listen("live_feed_event")` | `on("live_feed_event")`（ble.ts のローカル emitter） |
| `src/hooks/useDiag.ts` | 同上 | 同上 |
| `src/keymap/cache.ts` | Rust の `cache_read/write`（app data dir） | **localStorage** + JSON import/export |
| `src/rpc/connect.ts` | `invoke("transport_send_data")` + `listen("connection_data")` | `rpcSend()` + `on("connection_data")` |
| `src/App.tsx` | ウィンドウ制御 / drag region / スキャン UI | URL パラメータ / オンボーディング / import UI |

### 新規（Web のみ）

- `src/config.ts` — URL パラメータ + localStorage の設定解決（優先度: URL > localStorage > 既定）
- `src/Landing.tsx` — 説明ページ（入口）。§6 参照
- `src/pip.ts` — Document Picture-in-Picture（常に最前面）。§6.3 参照
- `src/bridge.ts` — 別ウィンドウへの live_feed 中継（BroadcastChannel）。§6.2 参照
- `src/boardSize.ts` — 盤面の実寸計算（子ウィンドウのサイズ決定）。§6.4 参照

---

## 3. Web Bluetooth 層（`src/ble.ts`）

### 方針: Tauri のインターフェースをそのまま模倣する

Float の Rust transport は「invoke で命令、event で受信」という形だった。`ble.ts` は
**同じ関数名・同じ `number[]` ペイロード**を保ち、Tauri のイベントバスだけを
**モジュールローカルの極小 emitter**（`on(name, handler) => unlisten`）に置換した。
おかげでフックの改修は `listen` → `on` の 1 行差分で済んでいる
（`on` は同期関数なので、Tauri 版が必要としていた「listen の Promise が解決する前に
cleanup が走った場合」の追跡コードが消えて、むしろ短くなった）。

### UUID（`src-tauri/src/transport/*.rs` から転記）

```
live_feed service : e1f4af00-1c2d-4b6e-9f3a-0a1b2c3d4e5f
  feed  char (af01): e1f4af01-1c2d-4b6e-9f3a-0a1b2c3d4e5f   NOTIFY + READ
  diag  char (af02): e1f4af02-1c2d-4b6e-9f3a-0a1b2c3d4e5f   NOTIFY + READ + WRITE
RPC service       : 00000000-0196-6107-c967-c5cfb1c2482a
  RPC   char      : 00000001-0196-6107-c967-c5cfb1c2482a
```

### デバイス選択

```ts
navigator.bluetooth.requestDevice({
  acceptAllDevices: true,
  optionalServices: [LIVE_FEED_SERVICE, RPC_SERVICE],
})
```

- `filters: [{ services: [...] }]` は**使えない**。キーボードは live_feed サービス UUID を
  アドバタイズパケットに載せていないため、フィルタするとダイアログが空になる。
- `requestDevice()` は**ユーザージェスチャ必須**なので、ボタンの `onClick` から
  同期的に呼ぶ経路を崩さないこと（`openLink()` に await を挟んでいないのはそのため）。

### notify → デコーダの配線

```
af01 startNotifications()
  → characteristicvaluechanged (DataView)
  → toNumbers() で number[] 化
  → emit("live_feed_event", bytes)
  → useLiveFeed の on(...) ハンドラ
  → decodeLiveFeed(bytes)   ← Float から無改修コピーした 16B デコーダ
  → applyEvent() → pressed Set / layer state
```

`toNumbers()` は `new Uint8Array(v.buffer, v.byteOffset, v.byteLength)` を使う。
`v.buffer` を直に読むと（実装によっては共有バッファのため）他の値が混ざる。

`addEventListener` の前に必ず `removeEventListener` を呼んでいる（**冪等な subscribe**）。
Rust 側の `live_feed_subscribe` が冪等だったのと同じ理由で、二重登録＝イベント二重処理を防ぐ。

### 切断検知

`device.addEventListener("gattserverdisconnected", ...)` → `active = null` にして
`emit("connection_disconnected")`。`useLiveFeed` がこれを拾って押下 Set をクリアし、
App が接続状態を `disconnected` に落として「再接続」ボタンを出す。

選んだ `BluetoothDevice` は `lastDevice` に保持しているので、**再接続はダイアログなし**で
できる（`canReconnect()`）。ただしページをリロードすると許可ごと失われる。

---

## 4. RPC 同期を「失敗しても致命傷にしない」構造

Web Bluetooth からの ZMK Studio RPC は**実機未検証**。したがって次の 3 層で隔離した。

**① 発見の分離（`ble.ts`）**
`attach()` は live_feed サービスと RPC サービスを**独立に**探す。live_feed が無ければ
接続そのものを失敗させる（それは本当に致命的）が、RPC が無い場合は `rpcError` に
理由を控えて接続は**成功扱い**にする。`rpcAvailable()` / `rpcUnavailableReason()` で問い合わせる。

**② 呼び出しの分離（`App.tsx` の `runSync`）**
`runSync()` は契約として **throw しない / 接続状態を触らない**。失敗はすべて
`syncNote`（閉じられる黄色い通知）になるだけで、`conn` も `cache` も壊さない。

**③ 接続経路からの切り離し（`App.tsx` の `openLink`）**
接続シーケンスは「live_feed subscribe（必須）→ SNAPSHOT read（best-effort）→
`void runSync(snap)`（await しない）」。`void` が肝で、RPC がハングしても
`setConn("connected")` は既に済んでおり、ライブ表示は流れ始めている。
しかも自動同期は**キャッシュが空のときだけ**走る。

**④ 逃げ道（経路B）**
`keymap/cache.ts` の `importCacheFile()` / `exportCacheFile()`。デスクトップ版の
`keymap-cache.json` をそのまま読める（スキーマ互換 = CACHE_VERSION 1）。
`parseCachedKeymap()` で構造検証しているので、無関係な JSON を掴まされても
FloatBoard の奥で render クラッシュせず、読めるエラーになる。

結果として **RPC が 1 バイトも通らなくても**、JSON を 1 回インポートすれば盤面は完成し、
押下ハイライトとレイヤー追従（= このアプリの本体）はフルに動く。

---

## 5. OBS / 透過の設計

- **透過契約**: `html / body / #root / .app` すべて `background: transparent !important`。
  不透明な下地（カード）を一切置かず、pill・キーキャップ・ログパネルだけが描画される。
  OBS のブラウザソースはページのアルファをそのまま合成するので、これで overlay になる。
  **例外は 2 つだけ**: 説明ページ（OBS には出ない・`?chrome=0` で消える）と、
  PiP ウィンドウの `.pip-root`（§6.3）。
- **URL パラメータ**で見た目を全部制御（`theme` / `legend` / `scale` / `opacity` / `chrome`）。
  優先度は **URL > localStorage > 既定**。`config.ts` の `resolveSettings()` に集約。
- **`chrome` は URL だけでなく実行時にも切替可能**にした（ヘッダの「隠す」 / `h` キー /
  左上隅の透明ハンドル）。これは意図的な設計判断:
  OBS で接続するには「操作」でクリックする必要があるが、接続後に `?chrome=0` へ**移動すると
  リロードになり Web Bluetooth の許可が飛ぶ**。リロードせずに chrome だけ消せる必要がある。

---

## 6. 表示方法 3 種 と「Web で実現できないこと」

デスクトップ版との差分を「できない」で終わらせず、**Web でできる範囲を最大化する**
ための層。ここが Web 版の設計上いちばん独自な部分。

### 6.0 「Web で実現できないこと」の訂正

初版の設計では「最前面はブラウザでは不可能」としていたが、**これは誤り**。
**Document Picture-in-Picture（Chrome / Edge 116+）で最前面は実現できる。**

Web で本当に実現できないのは、次の **4 点だけ**:

| # | できないこと | 補足 |
|---|---|---|
| 1 | **背景の透過**（OBS 内を除く） | 通常のタブも PiP 小窓も不透明。OBS のブラウザソースだけはページのアルファを合成するので透過オーバーレイになる |
| 2 | **クリックスルー** | `pointer-events` はページ内にしか効かない。OS ウィンドウのヒットテストは触れない |
| 3 | **トレイ常駐** | ブラウザタブが閉じればプロセスも終わる |
| 4 | **自動再接続** | Web Bluetooth の許可はドキュメント単位・ユーザージェスチャ起点。リロードすると必ず選び直し |

「常に最前面」は 4 点に含まれない = **実現済み**。

### 6.1 入口を説明ページにした理由（`Landing.tsx`）

デスクトップ版は「起動したら盤面」でよかった。Web 版は URL を他人に渡す前提なので、
盤面より先に **①ブラウザ要件 ②非自明な BLE プロファイル手順 ③表示方法の選択**
を通す必要がある。よって `/` は説明ページ、`?chrome=0` のときだけ説明を出さず
いきなり盤面（= OBS ブラウザソースと、下記の子ウィンドウが読む URL）。

### 6.2 (b) 最小ウィンドウ ＋ BroadcastChannel 中継（`bridge.ts`）

`window.open(url, "_blank", "popup,width=W,height=H")` で URL バーのない小窓を開く。
**問題**: 小窓は別ドキュメントなので GATT 接続を共有できない。Web Bluetooth の許可は
それを取得したドキュメントに属し、取り直すにはキーボードを再び advertising 状態に
する（= 3 ステップをもう一度）必要がある。

**解**: 小窓は BLE に触らせない。親タブが唯一の接続を保持し、`live_feed_event` の
**生バイト列**を同一オリジンの `BroadcastChannel("torabo-float-web")` へ再送する。
小窓（`?bridge=1`）は同じ `decodeLiveFeed()` に食わせるだけ。デコード経路が
親子で完全に同一になるので、表示ズレが原理的に起きない。

キーマップも同じ経路。小窓は localStorage からも読めるが、`hello` への返信で親の
**メモリ上の**キャッシュを送るようにしてある（localStorage への保存が
容量不足やプライバシーモードで失敗していた場合も描ける）。

### 6.3 (c) 常に最前面 = Document PiP（`pip.ts`）

`documentPictureInPicture.requestWindow({width, height})`。ユーザージェスチャ必須。
実装上の落とし穴は 2 つ、どちらも `pip.ts` で処理済み:

1. **親の CSS は一切継承されない。** PiP の `document` は空で始まる。
   `copyStyles()` が `document.styleSheets`（＋ `adoptedStyleSheets`）の全ルールを
   直列化して `<style>` として注入する。Vite は dev で `<style>` 注入、build で
   同一オリジン `<link>` なのでどちらも `cssRules` が読める。読めない場合（将来の
   クロスオリジン CSS）は `href` で貼り直すフォールバックあり。
2. **CSS 変数テーマは `documentElement` 上のランタイム状態。** `data-theme` と
   `--ui-alpha` は親のルート要素に設定されているので、ルールを写すだけでは無テーマに
   なる。`syncPipTheme()` が PiP のルートにも反映し、設定変更のたびに再実行する。

**接続の保持**: 盤面は React の `createPortal` で PiP の `body` 配下へ描画する。
PiP は別ウィンドウだが**同じ React ツリー**なので、props・state・BLE 購読は
親ドキュメントに残ったまま。`pagehide` で `pip` state を null にすると、
ポータルが外れて盤面が元の位置へ戻るだけ（**切断されない**）。
コンポーネント unmount 時は PiP ウィンドウを `close()` して孤児を作らない。

PiP だけは**透過契約の唯一の例外**で、`.pip-root` に不透明な `--pip-bg`（テーマ別）を
敷いている。透明にするとデスクトップの任意の内容の上で淡色キーが読めなくなるため。

### 6.4 子ウィンドウのサイズ（`boardSize.ts`）

(b)(c) はボタンを押した瞬間に px を渡す必要があるが、そのとき画面に出ているのは
説明ページで盤面は mount されていない（`getBoundingClientRect()` も
`onContentSize` も使えない）。よってキャッシュ済みレイアウトから
`PhysicalLayout.tsx` の `computeContentBounds()` と**同じ回転外接矩形**を計算する。
`PhysicalLayout.tsx` は Float と byte 一致を保つ対象（§2）なので export を足さず
複製した。**レイアウト計算を変えるときは両方直すこと。**

---

## 7. Web Bluetooth 実測でわかったこと（経緯）

ユーザーによる実測で判明した、ドキュメントに書かれていない挙動:

1. ブラウザのデバイス選択ダイアログには **advertising 中のデバイスしか出ない**。
   ZMK のキーボードは接続済みプロファイルでは advertising しないので、
   **空き BLE プロファイルに切り替えてから**でないと候補に現れない。
2. 接続後、そのままだとキー入力がブラウザ側（＝この Web アプリを開いている PC）に
   流れてしまう。**キーボードを元のプロファイルに戻す**と、HID は本来の PC へ、
   live_feed の NOTIFY はこちらへ、という狙い通りの状態になる。

この 2 点は非自明で、知らないと「デバイスが出てこない」「繋いだのに何も出ない」で詰む。
そのため説明ページ（`Landing.tsx`）の「1. キーボードにつなぐ」に
**3 ステップとして常時表示**している。README にも同じ内容を書いた。

### 実機で確認できたこと（2026-08-09）

単一 HTML ビルド（`npm run build:single` → `dist-single/index.html`）を **`file://` で
直接ダブルクリック起動 → Web Bluetooth でペアリング → GATT 接続 → キー入力のライブ表示**
まで、実機の Chrome で確認済み。Node・Python・ローカルサーバーなしで HTML 1 ファイルだけ
で動作することが実証された（README「オフライン / インストール不要で使う」参照）。
Playwright での事前検証（API の存在・`localStorage` 挙動のみ）で残っていた
「実機ペアリング可否は未確認」という保留は、これで解消。

### 実機で確認できたこと（2026-08-07）

Windows の Chrome で、**live_feed の NOTIFY も ZMK Studio RPC の往復も動作**した。
RPC 応答の実例:

```json
{"kind":"requestResponse","requestId":7,"core":{"getDeviceInfo":{"name":"MS-torabo-tsuki"}}}
```

したがって **経路A（RPC 同期）が主経路**。経路B（JSON）は保険および他人配布用として残す。

---

## 8. 未検証事項（レビュー・実機確認したい点）

| # | 項目 | 影響 | 保険 |
|---|---|---|---|
| 1 | **OBS の CEF で Web Bluetooth が使えるか** | 使えないとライブ表示が OBS 内で動かない | 経路B で静的な盤面は出せる。最悪はデスクトップ Float をウィンドウキャプチャ |
| 2 | ~~ブラウザから ZMK Studio RPC が通るか~~ | **実機で確認済み（§7）** | — |
| 3 | RPC の書き込みチャンクサイズ | 20B 固定（MTU 23 の安全値）。実際の MTU が大きければ非効率、小さいことはない | — |
| 4 | `writeValueWithoutResponse` の可否 | 未対応実装では `writeValue` にフォールバック済 | フォールバック実装済 |
| 5 | 切断後の `reconnect()` の成功率 | Chrome は `BluetoothDevice` を保持していれば再接続できるはずだが未実測 | 「接続」でダイアログからやり直せる |
| 6 | localStorage 容量 | 実データ約 28 KB / 上限約 5 MB なので余裕。将来レイアウトが増えたら IndexedDB へ | 保存失敗してもセッション中はメモリ上のキャッシュで描画継続 |
| 7 | **PiP / 小窓を実機の BLE 接続下で長時間使ったときの挙動** | Playwright では PiP・小窓とも起動・描画・テーマ同期・クローズ復帰まで確認済みだが、BLE 接続下での検証は未実施 | 閉じれば必ず親タブへ戻る（接続には触れない設計） |

### 実装上の申し送り

- `package.json` の devDependency **`run-script-os` は削除しないこと**。
  `@zmkfirmware/zmk-studio-ts-client` の `postinstall` が `run-script-os` を呼ぶが、
  公開 tarball には `src/` が無いため実質 no-op。しかし run-script-os 本体が無いと
  `npm install` が exit 1 で落ちる。
- 上記 12 ファイルを更新するときは Float 側と**両方**直すこと。片側だけ直すと乖離する。
- `boardSize.ts` の外接矩形計算は `keyboard/PhysicalLayout.tsx` の
  `computeContentBounds()` の写し（§6.4）。片方だけ直すと子ウィンドウのサイズがずれる。
- 隠しファイル入力（`input.hidden-file`）は `<div className="app">` 直下に
  **無条件で** mount すること。⚙ 行の中に置くと、⚙ を開いていないとき
  （＝説明ページ表示中）に `fileRef.current` が null で JSON インポートが無反応になる。

---

## 9. 段階（今後）

| 段階 | 内容 | 状態 |
|---|---|---|
| 1 | スキャフォールド + 純ロジック移植 | ✅ |
| 2 | Web Bluetooth 層 + live_feed 配線 | ✅（実機確認済み） |
| 3 | キーマップ 2 経路（RPC / JSON） | ✅（RPC も実機確認済み） |
| 4 | OBS 向け透過 + URL パラメータ + オンボーディング | ✅ |
| 5 | 説明ページ + 表示方法 3 種（このページ / 小窓 / 最前面 PiP） | ✅ |
| 6 | 実機検証（BLE 接続 / RPC） | ✅ / OBS CEF は ⬜ |
| 7 | GitHub Private リポジトリ作成 + Pages 公開 | ⬜ |
