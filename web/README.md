# Torabo-Float-Web

**ブラウザで動く、torabo-tsuki の「いま押しているキー / アクティブレイヤー」ライブ表示。**

[Torabo-Float](..)（Tauri 製 Windows 常駐アプリ）の **Web 版**です。
インストール不要で、**URL を渡すだけで他の人にも使ってもらえます**。背景が完全透過なので、
**OBS のブラウザソース**にそのまま入れて配信オーバーレイにできます。

> このディレクトリは元々 `tak-2025/Torabo-Float-Web` という独立リポジトリでしたが、
> デスクトップ版と同じソース（live_feed デコーダ・盤面描画・キャッシュ形式・
> スタイルシート）を共有しているため、Torabo-Float の `web/` に統合しました。

## 公開 URL / ダウンロード

| 用途 | URL |
|---|---|
| サイト | <https://tak-2025.github.io/Torabo-Float/> |
| OBS のブラウザソース | <https://tak-2025.github.io/Torabo-Float/?chrome=0> |
| 単一 HTML（落として開くだけ） | <https://tak-2025.github.io/Torabo-Float/torabo-float-web.html> |

公開は [`.github/workflows/pages.yml`](../.github/workflows/pages.yml) が `web/` への push で
自動実行します（詳細は後述の「GitHub Pages への公開」）。

> ⚠️ キーマップの**編集機能はありません**（表示専用）。編集は Torabo Studio をご利用ください。
> ⚠️ 本プロジェクトは ZMK Project とは **提携・承認関係にありません**。

---

## できること

- キー押下のライブハイライト（物理レイアウト上）
- アクティブレイヤーの追従表示（レイヤー名 + レイヤーに応じた刻印切替）
- 盤面の表示方法を 3 種類から選択（このページ / 最小ウィンドウ / **常に最前面**）
- テーマ5種 / JIS・US 刻印切替 / 表示サイズ / 不透明度
- キーマップの JSON インポート・エクスポート（Torabo Float キャッシュ / Torabo Studio
  バックアップの両形式に対応。**これが主経路**）と、補助としての RPC 自動同期
- 診断パネル（af02 対応 FW のみ）

トップページは**説明ページ**です。接続手順・表示方法・OBS の設定がそこに全部あります
（`?chrome=0` のときだけは説明を出さず、いきなり盤面になります = OBS 用）。

---

## 動作要件

| 項目 | 内容 |
|---|---|
| ブラウザ | **Chrome / Edge のデスクトップ版**（Web Bluetooth 必須） |
| 非対応 | **iOS / iPadOS の Safari**、Firefox、Safari (macOS) |
| キーボード | `torabo-tsuki_ext_FW` の `torabo-live-feed` スニペット入り FW |
| 配信 | HTTPS または `localhost`（Web Bluetooth はセキュアコンテキスト必須） |

---

## 接続手順（重要・非自明）

ブラウザのデバイス選択ダイアログには「**いま advertising しているデバイス**」しか出てきません。
ZMK のキーボードは**接続済みのプロファイルでは advertising しない**ため、次の順番が必要です。

1. **キーボードを空き BLE プロファイルに切り替える**
   （ZMK なら未使用プロファイルを選ぶキー。torabo-tsuki の既定ではレイヤー3 の `&bt BT_SEL 0…4`。
   機種・キーマップにより異なります）
2. アプリの **「接続」** ボタン → ブラウザのダイアログでキーボードを選ぶ
3. 接続できたら、**キーボードを元のプロファイル（普段使っている PC）に戻す**
   → キー入力は本来の PC に流れ、こちらにはフィードだけが届きます

この3ステップは説明ページにも表示されます。

> BLE プロファイルを 1 枠使います。空きがない場合はどれかを解放してください。

---

## 盤面の表示方法（3種類）

説明ページの「2. 盤面の表示方法をえらぶ」から選びます。**接続はどの方法でも
最初のタブが持ったまま**なので、子ウィンドウを閉じても切断されません。

| | 方法 | 最前面 | 背景透過 | 用途 |
|---|---|---|---|---|
| **(a)** | このページで表示 | ✗ | ✗（OBS 内でのみ） | とりあえず見る / OBS |
| **(b)** | 最小ウィンドウで開く | ✗ | ✗ | サブディスプレイに置く |
| **(c)** | **常に最前面で開く** | **✓** | ✗ | **デスクトップ版に最も近い** |

### (a) このページで表示

このタブがそのまま盤面になります。ヘッダの「隠す」または `h` キーで操作パネルを
消せます。OBS のブラウザソースはこの状態（`?chrome=0`）を読み込みます。

### (b) 最小ウィンドウで開く

`window.open(..., "popup,width=W,height=H")` で、URL バーもタブもない小窓に
`?chrome=0&bridge=1` の盤面だけを開きます。W/H はキャッシュ済みレイアウトの実寸
（回転を含む外接矩形 × 表示倍率）から計算します。

小窓は**別ドキュメント**なので GATT 接続を共有できません。そのため元のタブが
BLE を保持したまま、生の live_feed フレームを `BroadcastChannel` で小窓へ中継します
（キーマップも同じ経路で渡します）。小窓側は BLE に一切触れません。

### (c) 常に最前面で開く ★

**Document Picture-in-Picture**（Chrome / Edge 116+）を使い、**他のウィンドウより
常に手前**に浮く小窓へ盤面を出します。デスクトップ版 Torabo Float に最も近い体験です。

> **透過はできませんが、常に最前面にはできます。**
> PiP ウィンドウはページのアルファを合成しないため不透明な小窓になります。
> 背景を透過したい場合は OBS のブラウザソースを使ってください。
> クリックスルーもできません。

PiP ウィンドウは同一ドキュメントツリー内の別 `Document` なので、盤面は React の
`createPortal` でそこへ描画されます。**BLE 接続・設定・RPC はすべて元のタブ側に
残る**ため、PiP を閉じても切断されず、盤面が元の位置に戻るだけです。
非対応ブラウザではボタンが無効化され、理由が表示されます。

---

## OBS での使い方

1. OBS → ソース → **ブラウザ** を追加
2. URL に本アプリのアドレス + パラメータを入れる（下記）
3. 幅・高さは盤面に合わせて調整（`scale=auto` なら枠に自動フィット）
4. 「**表示されていないときにソースをシャットダウン**」は **オフ**推奨（切断されるため）

背景は完全透過なので、そのまま他のソースに重ねられます。

### URL パラメータ

| パラメータ | 値 | 既定 | 説明 |
|---|---|---|---|
| `theme` | `pale` / `dark` / `sakura` / `mint` / `contrast` | `pale` | 配色 |
| `legend` | `jis` / `us` | `jis` | キーキャップ刻印 |
| `scale` | `auto` または `50`〜`200` | `auto` | 表示倍率（%）。`auto` は枠にフィット |
| `opacity` | `30`〜`100` | `100` | 不透明度（%） |
| `chrome` | `0` / `1` | `1` | `0` で説明ページと操作パネルを隠し**盤面だけ**にする |
| `bridge` | `0` / `1` | `0` | 内部用。(b) の小窓が付ける。BLE に接続せず、親タブから中継されたフィードだけを描画する |

例:

```
https://<公開先>/?chrome=0&theme=dark&scale=120&legend=jis&opacity=90
```

設定は localStorage にも保存されますが、**URL パラメータが常に優先**されます。
⚙ の「URL コピー」で、いまの見た目を再現する URL を取得できます。

### OBS で接続するときのコツ

ブラウザソースは Web Bluetooth のダイアログを出せない可能性があります（未検証・後述）。
確実な手順は次の通りです。

1. まず `chrome=1`（既定）で読み込む
2. OBS のソースを右クリック → **「操作」(Interact)** で操作パネルを出す
3. 「接続」して上記3ステップを完了させる
4. ヘッダの **「隠す」** か **`h` キー**で操作パネルを消す
   → **リロードせずに**盤面だけの表示になります
   （リロードすると Web Bluetooth の許可が失われ、再度クリック操作が必要になります）

盤面だけの状態から操作パネルを戻すには、**左上隅**にマウスを乗せると出る小さなハンドルを
クリックするか、`h` キーを押します。

---

## キーマップの供給

盤面を描くには**物理レイアウト（キーの並び）**と**キーマップ（各キーの割り当て）**が
必要です。接続（live_feed）はキーの**押下ハイライトとレイヤー表示**にしか使いません。

**JSON インポートが主経路**です。RPC 同期は「通ればラッキー」の補助経路として残して
あります。

### 経路A: JSON インポート（主経路・確実）

説明ページの「JSON をインポート」、盤面が空のときのボタン、または ⚙ →
**「JSON インポート」**から読み込みます。**形式は自動判別**され、次の 2 つを受け付けます。

#### A-1. Torabo Float のキャッシュ（推奨）

```
%APPDATA%\io.github.tak-2025.torabo-float\keymap-cache.json
```

デスクトップ版 Torabo-Float が書き出すファイルで、この Web 版の
**「エクスポート」ボタンが出力するファイルと同一形式**です。**そのまま読み込めます。**

トップレベルの構造（`src/keymap/cache.ts` の `CachedKeymap`）:

| キー | 型 | 必須 | 内容 |
|---|---|---|---|
| `version` | `1` | ✅ | キャッシュ版数。`1` 以外は拒否 |
| `layouts` | `{name, keys[]}[]` | ✅ | 全物理レイアウト。`keys[i]` は `{width,height,x,y,r,rx,ry}`（すべて 1/100 単位） |
| `activeLayoutIndex` | `number` | – | FW が報告する既定レイアウト番号（省略時 `0`） |
| `layers` | `{id, name, bindings[]}[]` | ✅ | レイヤー。`bindings[i]` は `{behaviorId, param1, param2}` で `layouts[n].keys[i]` と**添字で対応** |
| `behaviors` | `{ [id]: {id, displayName} }` | – | キー上部に出す表示名（省略時 `{}` → すべて "Unknown"） |
| `keymapCrc` | `number` | – | 同期時点の CRC。live_feed の値と食い違うと「再同期してください」が出る |
| `activeLayout` | `number` | – | 同期時点のアクティブレイアウト番号 |
| `syncedAt` | `number` | – | UNIX ミリ秒 |

#### A-2. Torabo Studio のバックアップ（変換して読み込み）

```
torabo-backup-YYYY-MM-DD-hh-mm-ss.json   (format: "torabo-tsuki-backup")
```

Torabo Studio の「バックアップ」パネルが出すファイルです。**変換して読み込めます**
（`src/keymap/import.ts`）。ただしバックアップは「同じキーボードに書き戻す」ための
ファイルなので、**物理レイアウトを含みません**。対応関係:

| バックアップ | Float キャッシュ | 変換 |
|---|---|---|
| `keymap.layers[i].bindings` | `layers[i].bindings` | そのままコピー |
| `keymap.layers[i].name` | `layers[i].name` | そのままコピー |
| （なし） | `layers[i].id` | **添字を id とみなす**。Studio でレイヤーを並べ替え／削除した機体ではハイライト対象レイヤーがずれる可能性あり |
| `behaviors`（v4+、`{ "8": "Key Press", … }`） | `behaviors`（`{8: {id:8, displayName:"Key Press"}}`） | 形を変えるだけ |
| （v1–v3 は `behaviors` なし） | `behaviors` | 既存キャッシュの名前表を流用（警告を表示）。無ければ空 = すべて "Unknown" |
| **（なし）** | **`layouts`** | 既存キャッシュの `layouts` → 無ければ**同梱の torabo-tsuki 標準配列 S/M/L**（`src/keymap/torabo-tsuki-layouts.json`）。警告を表示 |
| （なし） | `keymapCrc` | 接続中なら live_feed の現在値、未接続なら `0` |

> **behaviorId の機体依存問題について。** ZMK はビヘイビアの id を機体ごとに採番するため、
> バックアップの `behaviorId` は「そのファイルを作ったキーボード」でしか意味を持ちません。
> これは他機に**書き戻す**とき（Studio のリストア）に問題になります。
> 本アプリは**読み取り専用**で、v4 バックアップの `behaviorId` と同ファイル内の
> `behaviors` 名前表は互いに整合しているため、**そのファイルの表をそのまま採用すれば
> id の読み替えは不要**です。どの PC で読んでもキー名は正しく出ます。
> 名前表を持たない v1–v3 のバックアップだけは、id の意味が確定できないため警告が出ます。

### 経路B: RPC 同期（補助・自動）

接続中に ZMK Studio RPC でキーボードから直接取得します。成功すればファイル不要です。

ただし ZMK の RPC 特性は **INDICATE**（`gatt_rpc_transport.c`）で、1 往復あたり
約 20 バイトしか運べません。キーマップやビヘイビア一覧のような数 KB の応答は
ブラウザ経由だと**数十秒**かかり、環境によっては完了しません
（`getDeviceInfo` のような小さな応答だけ通る、という症状になります）。

対策として、RPC の待ち時間は**固定デッドラインではなくアイドルタイムアウト**
（`src/rpc/logging.ts`）にしてあります。受信バイトが届くたびにタイマーを張り直し、
**15 秒完全に無音**になったときだけ失敗と判定します（暴走防止の絶対上限は 120 秒）。
同期中は進捗（「キーマップを取得中…」「ビヘイビア情報を取得中… 3/28」）が表示されます。

同期が失敗しても致命傷にはなりません。通知が出るだけで、ライブ表示（キー押下・レイヤー）
はそのまま動きます。

### 保存と配布

インポートまたは同期した結果は **localStorage に保存**され、
**次回以降は接続も同期もなしで盤面が出ます**（⚙ →「キャッシュ削除」で消せます）。

**「エクスポート」**で書き出した `keymap-cache.json` を他の人に渡せば、その人は
キーボードを持っていなくても同じ盤面を表示できます（押下ハイライトには相手側の接続が必要）。

---

## 開発

```bash
npm install
npm run dev        # http://localhost:5174
npm run build      # dist/ に出力（相対パスなのでサブディレクトリ公開でも動く）
npm run typecheck
```

> `npm install` / `npm ci` は `.npmrc`（`ignore-scripts=true`）により postinstall
> スクリプトを一切実行しません。理由は下記「Cloudflare Pages への公開」の注記を参照。

---

## オフライン / インストール不要で使う（単一 HTML ビルド）

Node も Python も入っていない PC でも、**`index.html` をダブルクリックするだけ**で
起動できるビルドがあります。JS・CSS・同梱 JSON（キーマップ配列など）をすべて 1 枚の
HTML に埋め込むので、静的サーバーもビルド環境も不要です。

```bash
npm run build:single   # dist-single/index.html を生成（通常の dist/ とは別ディレクトリ）
```

`dist-single/index.html`（1 ファイル、目安 350KB 前後）をそのまま USB メモリやチャットで
渡せば、受け取った側は Chrome / Edge でダブルクリックして開くだけです。`npm run build` /
`npm run dev` / Cloudflare Pages へのデプロイ（`dist/` を使う経路）には一切影響しません。

内部的には [`vite-plugin-singlefile`](https://github.com/richardtallent/vite-plugin-singlefile)
を使い、`vite.config.singlefile.ts`（`vite.config.ts` とは別ファイル）でビルドしています。

### `file://` での動作確認済み（2026-08-09、実機 Chrome）

`dist-single/index.html` を **`file://` で直接ダブルクリック起動 → Web Bluetooth で
キーボードとペアリング → GATT 接続 → キー入力のライブ表示**まで、実機の Chrome で
正常動作することを確認済みです。**Node も Python もローカルサーバーも不要**で、
**HTML ファイル1個を渡すだけ**で使えることが実証されています。

- 単一 HTML（約 347KB）1 個で完結し、外部への通信は発生しません。
- `localStorage` も `file://` 上で問題なく機能するため、キーマップは一度読み込めば
  （JSON インポートまたは RPC 同期）、次回以降は再読み込み不要です。
- 動作確認済みブラウザ: **Chrome / Edge**（デスクトップ版）。
  **iOS / iPadOS の Safari、Firefox は Web Bluetooth 非対応のため利用できません。**

### 参考: 代替手段

環境の事情で `file://` が使えない場合は、`npm run build`（通常ビルド）で `dist/` を作り
`npx serve dist` 等でローカル配信するか、デスクトップ版 Torabo-Float（Tauri v2、ブラウザや
Web Bluetooth の制約を受けない）を使う選択肢もあります。

### 配布するとき

- 渡すファイル名は `index.html` のままにせず、**`torabo-float-web.html` のように
  分かる名前に変える**とよいです（`index.html` のままだと用途が分からず、他のファイルと
  紛らわしくなります）。Pages で配信しているものは既にこの名前になっているので、
  <https://tak-2025.github.io/Torabo-Float/torabo-float-web.html> をそのまま案内すれば
  手元でビルドする必要はありません。
- `.html` 添付はメール／チャットサービスによってはブロックされることがあります。
  その場合は **ZIP に圧縮する**か、クラウドストレージで共有するか、
  上のダウンロード URL を伝えてください。
- 動作要件は **Chrome / Edge のデスクトップ版のみ**です。Safari（macOS/iOS）や
  Firefox では動きません。渡す前に伝えておくと親切です。
- 受け取った人は**自分のキーマップを用意する必要があります**（接続後の RPC 自動同期、
  または JSON インポート。上記「キーマップの供給」参照）。
- ライセンス表記（Apache-2.0 と NOTICE）は **HTML ファイルの先頭コメントおよびアプリ内の
  「ライセンス」セクションに埋め込み済み**なので、ファイル単体で配布して問題ありません。

---

## GitHub Pages への公開

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) が、`web/` 配下への push
（および手動実行）で自動的にビルドして公開します。Torabo-Float リポジトリは Public なので、
GitHub Pages は無料プランのまま使えます。

ワークフローは 1 回のビルドで**サイトとダウンロード用の単一 HTML を同時に**出します。

| 出力 | 生成物 | 公開先 |
|---|---|---|
| サイト | `web/dist/` | `https://tak-2025.github.io/Torabo-Float/` |
| 単一 HTML | `web/dist-single/index.html` | `…/Torabo-Float/torabo-float-web.html` |

単一 HTML を Release ではなく Pages のペイロードに同梱しているのは、
**ダウンロードがサイトの内容から遅れることを構造的に防ぐ**ためです。

> ⚠️ **公開後のサイトは誰でもアクセスできます**（URL を知っていれば全世界から）。
> ビルド後の JS（React コンポーネントのロジック等）も閲覧・ダウンロード可能です。
> 秘密情報を埋め込まないでください。

### 初回だけ必要な設定

リポジトリの **Settings → Pages → Build and deployment → Source** を
**GitHub Actions** に切り替えてください（`gh api -X POST /repos/tak-2025/Torabo-Float/pages
-f build_type=workflow` でも設定できます）。以降はワークフロー任せです。

### 既知の落とし穴: postinstall が失敗する

依存する `@zmkfirmware/zmk-studio-ts-client` は `postinstall` で `run-script-os`
を呼びますが、これは同パッケージの devDependency であり**消費側には入らないため
全 OS で失敗します**（実害はありません。同パッケージは `lib/` にビルド済みコードを
同梱しており、消費側でのビルドは元々不要です）。

対策として **`.npmrc` に `ignore-scripts=true` を追加済み**で、ワークフローでも
`npm ci --ignore-scripts` を明示しています。`--ignore-scripts` は
esbuild / rollup / @swc のネイティブバイナリには影響しません
（`optionalDependencies` 経由で正しいプラットフォーム版が入り、各ツールの JS
エントリポイントが直接 require するため。postinstall は旧来のフォールバックです）。

### OBS のブラウザソース

説明ページではなく盤面だけを出すため、URL に `?chrome=0` を付けてください
（他の URL パラメータは上記「URL パラメータ」表を参照）。

```
https://tak-2025.github.io/Torabo-Float/?chrome=0
```

### Cloudflare Pages について

独立リポジトリだった頃は Cloudflare Pages 向けの設定と `deploy-cloudflare.yml` を
用意していましたが、統合にあたり公開先を GitHub Pages に一本化したため
**引き継いでいません**。Cloudflare へ出す場合は `web/` をルートディレクトリに指定し、
ビルドコマンド `npm ci --ignore-scripts && npm run build`、出力ディレクトリ `dist`、
環境変数 `NODE_VERSION=20` を設定してください。

---

## 既知の制約

- **Chrome / Edge のデスクトップ版のみ**。iOS / iPadOS Safari と Firefox は Web Bluetooth 非対応。
- **ページを読み込むたびにデバイス選択が必要**（Web Bluetooth の許可はセッション単位）。
  **自動再接続はできません。**リロードせずに使い続けるのが前提です。
- **BLE プロファイルを 1 枠消費**します。
- **背景の透過は OBS のブラウザソース内だけ**。通常のブラウザウィンドウでも、
  (c) の最前面（PiP）ウィンドウでも不透明になります。**クリックスルーも不可**、
  **トレイ常駐も不可**（この 4 点だけがデスクトップ版との機能差です。
  「常に最前面」は (c) で実現できます）。
- **OBS のブラウザソース (CEF) で Web Bluetooth が動くかは未検証**です。動かない場合でも、
  JSON インポートで「静的な盤面」は表示できます。
- **RPC 同期は保証されません。** ZMK の RPC は BLE の INDICATE（1 往復 ≈ 20 バイト）で
  運ばれるため、キーマップのような大きな応答はブラウザ経由だと数十秒かかり、環境に
  よっては完了しません。**JSON インポートが確実な経路**です（上記「キーマップの供給」参照）。
- **(c) 常に最前面は Chrome / Edge 116 以降**が必要です（Document Picture-in-Picture）。
  未対応環境ではボタンが無効化され、理由が表示されます。
- Mod-Tap / Sticky Shift の押下状態は追跡していません（デスクトップ版と同じ制約）。

---

## ライセンス

**Apache License 2.0**（[LICENSE](LICENSE)）。

本アプリは Torabo-Float / ZMK Studio / Torabo-Studio 由来のコードを含むため、Apache-2.0 第4条に
従い帰属表記を [NOTICE](NOTICE) に保持しています。再配布の際は LICENSE と NOTICE を必ず同梱して
ください。

---

## 関連プロジェクト

- **Torabo-Float** — デスクトップ版（Tauri v2、透過・最前面ウィンドウ）
- **[torabo-tsuki](https://github.com/sekigon-gonnoc/zmk-keyboard-torabo-tsuki-lp)** — キーボード本体（上流・GPL-3.0）
- **[torabo-tsuki_ext_FW](https://github.com/tak-2025/torabo-tsuki_ext_FW)** — `live_feed` を含む拡張 FW モジュール
- **[ZMK Firmware](https://zmk.dev/)** / **[ZMK Studio](https://github.com/zmkfirmware/zmk-studio)**
