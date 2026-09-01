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

`src/`（デスクトップ）と `web/src/` の同名ファイルの関係です。**「同一」の列は差分ゼロを維持する
約束**で、片方だけ直すのは禁止です（diff で同期を確認できることが目的）。

| 区分 | ファイル |
|---|---|
| **バイト単位で同一**（15） | `liveFeed.ts` / `main.tsx` / `diag.ts` / `DiagPanel.tsx` / `hid-usages.ts` / `keyboard/FloatBoard.tsx` / `keyboard/Key.tsx` / `keyboard/PhysicalLayout.tsx` / `keyboard/HidUsageLabel.tsx` / `keyboard/binding-face.ts` / `keyboard/legends.ts` ＋ データ 4 点（`hid-usage-name-overrides.json` / `keyboard-and-consumer-usage-tables.json` / `keyboard/behavior-short-names.json` / `keyboard/behavior-value-names.json`） |
| **書き換えたもの**（9） | `App.tsx` / `ble.ts` / `hooks/useLiveFeed.ts` / `hooks/useDiag.ts` / `keymap/cache.ts` / `keymap/sync.ts` / `rpc/connect.ts` / `rpc/logging.ts` / `styles.css` |
| **Web だけにあるもの**（11） | `serial.ts` / `link.ts` / `events.ts` / `config.ts` / `Landing.tsx` / `bridge.ts` / `pip.ts` / `boardSize.ts` / `rpc/activity.ts` / `keymap/import.ts` / `keymap/torabo-tsuki-layouts.json` |

`boardSize.ts` の幾何計算だけは `keyboard/PhysicalLayout.tsx` の `computeContentBounds()` と
**意図的に重複**しています。PhysicalLayout.tsx を「同一」の側に留めるため、そこから export せずに
複製しました。レイアウト計算を変えるときは両方直してください。

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
