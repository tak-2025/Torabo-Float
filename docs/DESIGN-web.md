# DESIGN-web — Web 版（`web/`）の設計

Status: 実装済み・実機検証済み（Windows の Chrome / Edge）。GitHub Pages で公開中
（<https://tak-2025.github.io/Torabo-Float/>）。

## 方針 — 差し替えるのは transport だけ

Web 版はデスクトップ版の書き直しではありません。**盤面描画・デコーダ・キャッシュ形式・
スタイルシートはそのまま**にして、ネイティブ transport（Rust の `bluest` / `serialport`）を
Web Bluetooth / Web Serial に置き換えたものです。

そのために Web 側の transport は、**Tauri のインターフェースをわざと模倣**しています。

- [`web/src/events.ts`](../web/src/events.ts) — Tauri の `listen()` と同じ契約（`on(name, handler)` が
  unlisten を返す）のイベントバス。流すイベント名も payload の形も
  [DESIGN-live-feed.md](DESIGN-live-feed.md) の 4 つと同一。
- [`web/src/link.ts`](../web/src/link.ts) — いま繋がっているのが BLE か USB かを知っている**唯一の場所**。
  `App.tsx` もフックも RPC 層も transport で分岐しません。接続ボタンだけが選択します。

## ソース共有の実態

2026-09 のフェーズ⓪（`refactor/single-source`）で、手で同一に保っていたファイルは
**単一ソース化**しました。`src/`（デスクトップ）と `web/src/`（Web）はもう同名ファイルを
それぞれ持たず、共有分はリポジトリ直下の [`shared/`](../shared/) に 1 部だけ存在し、両ターゲットが
そこを import します（`tsconfig.json` の `paths["@shared/*"]` と各 `vite.config*.ts` の
`resolve.alias["@shared"]` が向き先。ルートは `./shared`、`web/` からは `../shared`）。
「diff が空になることを確認する」というメンテナンス手順はこの分についてはもう存在しません
（コピーが 1 部しかないので diff できない＝壊れようがない）。

| 区分 | ファイル |
|---|---|
| **`shared/` に集約 — Float 自前**（10） | `liveFeed.ts` / `diag.ts` / `DiagPanel.tsx` / `keyboard/FloatBoard.tsx` / `keyboard/Key.tsx` / `keyboard/PhysicalLayout.tsx` / `keyboard/HidUsageLabel.tsx` / `hooks/useLiveFeed.ts` / `hooks/useDiag.ts` / `keymap/types.ts`（新設。`CachedKeymap` 型だけを抽出。下記参照） |
| **`shared/` に集約 — torabo-studio から翻訳**（9） | `hid-usages.ts` / `keyboard/binding-face.ts` / `keyboard/sizing.ts`（新設。フェーズ③の継ぎ目 — 下記参照） / `keyboard/legends.ts` / `dynamic_macros/dmacConfig.ts`（新設） ＋ データ 4 点（`hid-usage-name-overrides.json` / `keyboard-and-consumer-usage-tables.json` / `keyboard/behavior-short-names.json` / `keyboard/behavior-value-names.json`）。下記「Studio → Float トランスレーター」参照 |
| **各ターゲットに残したもの（意図的に別実装）** | `App.tsx`（UI の骨格そのものが別物 = URL 設定・Landing・3 表示方式・route B は Web だけ） / `main.tsx`（9 行の起点シムだが `./App` の相対 import が絡むため見送り。下記参照） / `ble.ts`（transport 実装そのもの） / `events.ts`・`link.ts`（後述の継ぎ目。実装は別） / `keymap/cache.ts`（保存先が Rust invoke と localStorage で別。型だけ `shared/keymap/types.ts` へ） / `keymap/sync.ts`（Web は進捗コールバック＋GATT書き込み失敗の補足を持つ） / `rpc/connect.ts`（transport 別の unsubscribe） / `rpc/logging.ts`（タイムアウト戦略が別：デスクトップ4秒固定 / Webはアイドル15秒+上限120秒） / `styles.css`（Web 追加分が大きく単純な追記ではない） |
| **Web だけにあるもの**（11） | `serial.ts` / `link.ts` / `events.ts` / `config.ts` / `Landing.tsx` / `bridge.ts` / `pip.ts` / `boardSize.ts` / `rpc/activity.ts` / `keymap/import.ts` / `keymap/torabo-tsuki-layouts.json` |

### Studio → Float トランスレーター

2026-09（PLAN-translators.md フェーズ②）から、上の「torabo-studio から翻訳」の 9 ファイルは
**torabo-studio が唯一の源流**です。手編集は禁止（tako-custom の builder-only ルールと同じ規律）。
直すのは常に `torabo-studio/src/` 側で、`Torabo-Float/scripts/translate-from-studio.mjs`
（`npm run translate`）がその内容をここへコピーします。`npm run translate:check` は
ドリフトがあれば exit 1 になる dry-run で、CI やコミット前確認に使えます。

`keyboard/binding-face.ts` は 3 系統（Studio の MacroNames 対応 / 旧 Float の FaceSource
間接化 / Key-App の CachedBehavior 依存）に分かれていたものを 1 ファイルへ統合したもの
です。外部依存は構造的な型（`BehaviorFaceSource`）とデフォルト引数（`macroNames = null`）
だけに絞られていて、Float の呼び出し側（`FloatBoard.tsx`）は 3 引数のまま
（`resolveBindingFace(binding, behavior, layers)`）で変更不要 — 4 引数目を省略すると
今まで通り `M<N>` フォールバックになります。マクロ名表示自体（フェーズ③）は
`FloatBoard.tsx` 側が `macroNames` を渡すようになった時点で有効になります。

`keyboard/Key.tsx` と `keyboard/HidUsageLabel.tsx` は Studio 版と実装が本質的に別物
（Studio はインタラクティブな daisyUI/Tailwind の `<button>`、Float は読み取り専用の
プレーン CSS `<div>`）なので翻訳対象に**含めていません**。Float 自前のまま
`shared/keyboard/` に残ります。

`boardSize.ts` の幾何計算だけは `keyboard/PhysicalLayout.tsx` の `computeContentBounds()` と
**意図的に重複**しています。PhysicalLayout.tsx が `shared/` へ移った後も、そこから export せずに
複製したままです。レイアウト計算を変えるときは両方直してください。

### 継ぎ目（seam）— `events.ts` / `link.ts`

`hooks/useLiveFeed.ts` と `hooks/useDiag.ts` は元々「イベント購読の入口が Tauri の `listen()` か
`events.ts` の `on()` か」だけが違う書き換え組でした。それぞれのターゲットが同じ
`on(name, handler): Unlisten` 契約を持つ `events.ts`（さらに useDiag は診断コマンド 3 つを持つ
`link.ts`）を **自分の src ルートに置く**ことにして、フックからは `~/events` / `~/link`
（`tsconfig.json` の `paths["~/*"]`、`vite.config*.ts` の `resolve.alias["~"]`。ルートは `./src`）
という一貫した名前で参照させ、フック本体を `shared/hooks/` へ統合しました。

- `src/events.ts`（新設）— Tauri の `listen()`/`UnlistenFn`（非同期）を、Web 版と同じ同期 `on()` に
  アダプトするだけの薄いラッパー。
- `src/link.ts`（新設）— デスクトップは transport が Rust 側 (`ble.ts` 内) で既に統合済みなので、
  診断 3 関数を `./ble` から re-export するだけ。
- `web/src/events.ts` / `web/src/link.ts` は元々あった実装のまま（BLE/USB 2 transport を実際に
  仲介する本体）。

同じ契約を挟むことで購読ロジックが完全に同一になったので `hooks/*` を共有できましたが、
`events.ts`/`link.ts` 自体は実装が別物なので共有していません（契約だけ共通）。

### 移すのを見送ったもの — `main.tsx`

`main.tsx` もバイト単位で同一でしたが、`shared/` へ移すには中身の
`import { App } from "./App"` を alias 参照に変えるだけでなく、`index.html` の
`<script src="/src/main.tsx">` が Vite のプロジェクトルート外を指すことになり、Web 側で
`server.fs.allow` の追加設定が要ります。9 行のボイラープレートのためにその設定面を増やす
価値がないと判断し、重複のまま残しました（`~/App` alias は他の継ぎ目で導入済みなので、
将来 index.html 側の解決策が見つかれば移せます）。

## 表示 3 方式

透過・最前面はブラウザにはありません。代わりに 3 つの出し方を用意し、トップページ
（[`Landing.tsx`](../web/src/Landing.tsx)）で選ばせます。

| 方式 | 実装 | 中身 |
|---|---|---|
| **このページで表示** | `App.tsx` | 同じタブに盤面を出すだけ。いちばん単純 |
| **最小ウィンドウで開く** | [`bridge.ts`](../web/src/bridge.ts) | `window.open()` した子ウィンドウに盤面。**子は接続しない** |
| **常に最前面で開く**（推奨） | [`pip.ts`](../web/src/pip.ts) | Document Picture-in-Picture。OS が他のウィンドウの上に出す。Chrome / Edge 116+ |

後ろ 2 つに共通する設計は「**接続は親、描画は子**」です。

- Web Bluetooth の許可は**それを要求したドキュメントのもの**で、別ドキュメントへは引き継げません。
  子ウィンドウが接続し直すには、キーボードをもう一度アドバタイズさせる（例のプロファイル切替を
  やり直す）必要があり、現実的ではありません。
- そこで「最小ウィンドウ」は、親が唯一の BLE リンクを保持したまま、生の 16 バイトフレームを
  同一オリジンの BroadcastChannel（`torabo-float-web`）へ中継します。子は同じ `decodeLiveFeed()` で
  デコードして描くだけ。キーマップも同じ経路で親の実メモリから渡します（localStorage への書き込みが
  失敗している場合も動くように）。
- PiP のほうは**同じドキュメントのまま** `createPortal` で PiP 側の document に描画します。
  PiP ウィンドウを閉じてもアンマウントされるのは portal だけで、GATT 接続は無傷です。

> PiP の document は**空で始まり、親のスタイルシートを一切継承しません**。`copyStyles()` が
> `document.styleSheets` を丸ごと直列化して流し込み、`syncPipTheme()` が
> `--ui-alpha` や `data-theme` といった親の documentElement 側の値を PiP root へミラーします。
> テーマ設定を変えたら再実行が要ります。

## URL パラメータ

OBS のブラウザソースには UI がありません。**⚙ で変えられるものは全部クエリでも指定できる**
必要があるため、`config.ts` は **URL > localStorage > 既定値**の優先順で解決します。

| パラメータ | 値 |
|---|---|
| `?theme=` | `pale` / `dark` / `sakura` / `mint` / `contrast` |
| `?legend=` | `us` / `jis` |
| `?scale=` | `auto`、または `50`〜`200`（%） |
| `?opacity=` | `30`〜`100`（%） |
| `?chrome=` | `0` = 盤面のみ（ヘッダー・設定・説明を出さない。OBS 用）／`1` |

`?chrome=0` のときだけ説明ページを挟まず、いきなり盤面になります。

## Web でできないこと

- **背景の透過とクリックスルー**。透過が効くのは OBS のブラウザソース内だけで、通常の
  ブラウザウィンドウでも PiP ウィンドウでも不透明です。
- **自動再接続**。Web Bluetooth / Web Serial の許可はセッション単位なので、ページを開くたびに
  デバイス選択が要ります。リロードせずに使い続けるのが前提です。
- **接続中のキーボードの列挙**（Windows で確認）。ブラウザはアドバタイズ中の機器しか出せず、
  ZMK は接続中アドバタイズしません。Torabo Studio と同じ制約で、回避手順も同じです。
- OBS のブラウザソース（CEF）で Web Bluetooth / Web Serial が動くかは**未検証**です。動かなくても
  JSON インポートで静的な盤面は出せます。
