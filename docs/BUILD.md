# BUILD — ビルドと配布

**ビルド済みバイナリは配布していません。** デスクトップ版が必要な場合は自分でビルドします。
Web 版は GitHub Pages で公開しているので、ビルド不要で使えます。

## デスクトップ版（`src/` + `src-tauri/`）

Node.js と Rust ツールチェーン（Tauri v2 用）が要ります。

```bash
npm install          # 追加フラグ不要（後述の .npmrc）
npm run tauri dev    # 開発（Vite は :5173 固定 — Tauri が固定ポートを要求するため）
npm run tauri build  # 配布ビルド
```

## Web 版（`web/`）

Rust は不要です。`web/` は**独立した npm プロジェクト**で、ルートとは別に依存を持ちます。

```bash
cd web
npm ci --ignore-scripts   # web/.npmrc も同じ設定だが、CI と同様に明示
npm run dev               # 開発サーバ（http://localhost:5178）
npm run build             # dist/ — Pages で配信するサイト
npm run build:single      # dist-single/index.html — 単一 HTML
npm run typecheck         # tsc --noEmit
```

### 単一 HTML ビルド

[`vite-plugin-singlefile`](https://github.com/richardtallent/vite-plugin-singlefile) を使い、
`vite.config.singlefile.ts`（`vite.config.ts` とは別ファイル）でビルドします。JS も CSS も
インライン化した **1 ファイル** のみとなります。

- `file://` のままで Web Bluetooth のペアリング・GATT 接続・ライブ表示まで動くことを実機で確認済み。
  外部への通信は発生しません。
- `localStorage` も `file://` で機能するので、キーマップは一度読ませれば次回以降そのままです
  （**保存先は `https://` で開いた場合とは別枠**）。
- 帰属表記（Apache-2.0 / NOTICE）はファイル先頭のコメントとアプリ内に埋め込み済みなので、
  この 1 枚をそのまま人に渡せます。
- 通常の `npm run build` / `npm run dev` には影響しません。

## `.npmrc`（`ignore-scripts=true`）— ルートと `web/` の両方にある

`@zmkfirmware/zmk-studio-ts-client` は **devDependency しか使わない postinstall**（`run-script-os`）を
出荷しています。消費側にはその devDependency が入らないので、**全 OS で必ず失敗**します
（そもそもビルドするものは無く、パッケージは `lib/` にビルド済み出力を同梱しています）。

同居する `esbuild` / `@swc/core` / `protobufjs` にも postinstall がありますが、どれも
load-bearing ではありません（前 2 つは npm が optionalDependencies で入れたネイティブバイナリを
*検証*するだけ、`protobufjs` はバージョン不一致の警告を出すだけ）。

そのため両方に `ignore-scripts=true` を置いてあり、**素の `npm install` / `npm ci` がそのまま通ります**。

## 公開（GitHub Pages）

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) が `web/**` への push で自動実行し、
**同じソースから 2 つの成果物**を公開します。

| 出力 | 公開先 |
|---|---|
| `dist/` | サイト本体（Pages のルート） |
| `dist-single/index.html` | `/torabo-float-web.html`（Landing.tsx が案内するダウンロード用の 1 枚） |

単一 HTML を Release ではなく Pages のペイロードに含めているのは、**ダウンロードがサイトより
古くなることを構造的に防ぐ**ためです。デスクトップ版（`src/` + `src-tauri/`）はここではビルドしません。

## `shared/` — 単一ソース

盤面描画・デコーダ・キャッシュ形式のうち両ターゲットで同一のものは、リポジトリ直下の
[`shared/`](../shared/) に 1 部だけあります（内訳は [DESIGN-web.md](DESIGN-web.md) の表）。
`src/` と `web/src/` はそれぞれ `@shared/*`（`tsconfig.json` の `paths` と
`vite.config*.ts` の `resolve.alias`）で参照するだけで、コピーは持ちません。
「同期のメンテナンス」＝ 2 箇所を同じに保つ作業は、この分については発生しません
（直す場所が 1 箇所しかないため）。

デスクトップ / Web だけの継ぎ目ファイル（`events.ts` / `link.ts`）と、両ターゲットに
意図的に残した書き換え組（`App.tsx` / `ble.ts` / `keymap/cache.ts` / `keymap/sync.ts` /
`rpc/connect.ts` / `rpc/logging.ts` / `styles.css`）は今まで通り各ターゲットで個別に直します。
理由は DESIGN-web.md の表に添えてあります。
