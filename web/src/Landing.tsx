// Landing page — the front door of the web build.
//
// The desktop app could just appear as a floating board because it *was* the
// window. In a browser the same board is preceded by three things the user has
// to know before anything works: the browser requirement, the non-obvious BLE
// profile dance, and the choice of how the board should be displayed. Putting
// them on an explicit page (instead of a small onboarding pill over the board)
// is what makes the URL shareable to someone who has never seen the app.
//
// Never rendered in `?chrome=0`: that URL exists for OBS browser sources, which
// must land straight on the board with no chrome at all.

import { ThemeId } from "./config";
// Pulled in verbatim at build time so the on-page text can never drift from
// the actual NOTICE file that ships alongside LICENSE in the repo root.
import noticeText from "../NOTICE?raw";

// Absolute (not relative) on purpose: this same link is rendered inside the
// single-file build too, which people open from file:// or from a copy they
// were handed — a relative href would 404 there. Published by the Pages
// workflow, which copies dist-single/index.html to this path.
const SINGLE_FILE_URL =
  "https://tak-2025.github.io/Torabo-Float/torabo-float-web.html";

export interface LaunchInfo {
  /** Board size the (b)/(c) launchers will request, in CSS px. */
  width: number;
  height: number;
  /** False while no keymap is loaded — the child window would be empty. */
  ready: boolean;
}

export function Landing({
  supported,
  connState,
  canReconnect,
  onConnect,
  onReconnect,
  onImport,
  onExport,
  onSync,
  hasKeymap,
  syncing,
  onShowHere,
  onOpenPopup,
  onOpenPip,
  pipReason,
  launch,
  theme,
  baseUrl,
  launchNote,
  importNote,
}: {
  supported: boolean;
  connState: "disconnected" | "connecting" | "connected";
  canReconnect: boolean;
  onConnect: () => void;
  onReconnect: () => void;
  onImport: () => void;
  onExport: () => void;
  onSync: () => void;
  hasKeymap: boolean;
  syncing: boolean;
  onShowHere: () => void;
  onOpenPopup: () => void;
  onOpenPip: () => void;
  pipReason: string | null;
  launch: LaunchInfo;
  theme: ThemeId;
  baseUrl: string;
  launchNote: string;
  importNote: string;
}) {
  const connecting = connState === "connecting";
  const connected = connState === "connected";
  const obsUrl = `${baseUrl}?chrome=0&theme=${theme}`;

  return (
    <div className="landing">
      <section className="lp-hero">
        <h1 className="lp-title">Torabo Float Web</h1>
        <p className="lp-lead">
          torabo-tsuki の<strong>いま押しているキー</strong>と
          <strong>アクティブレイヤー</strong>を、ブラウザでライブ表示します。
          インストール不要。URL を渡すだけで他の人にも使ってもらえます。
          <br />
          <a href={SINGLE_FILE_URL} download>
            HTML 1 枚をダウンロード
          </a>
          すれば、オフラインでもローカルファイルのまま同じように動きます。
        </p>
        <p className="lp-sub muted">
          動作するのは <strong>Chrome / Edge のデスクトップ版</strong>だけです
          （Web Bluetooth 必須）。iOS / iPadOS の Safari、Firefox、macOS の Safari
          では動きません。キーマップの編集機能はありません（表示専用）。
        </p>
        {!supported && (
          <div className="error">
            このブラウザは Web Bluetooth に対応していません。Chrome または Edge
            のデスクトップ版で開いてください。
          </div>
        )}
      </section>

      {/* ---- 1. connect ---- */}
      <section className="lp-section">
        <h2 className="lp-h2">
          <span className="lp-num">1</span> キーボードにつなぐ
        </h2>
        <p className="lp-note">
          ブラウザのデバイス選択ダイアログには
          <strong>いま advertising しているデバイス</strong>しか出てきません。
          ZMK のキーボードは接続済みのプロファイルでは advertising しないので、
          次の順番が必要です。
        </p>
        <ol className="lp-steps">
          <li>
            キーボードを<strong>空き BLE プロファイル</strong>に切り替える
            <span className="muted">
              （torabo-tsuki の既定ではレイヤー3 の <code>&amp;bt BT_SEL 0…4</code>。
              機種・キーマップにより異なります。BLE プロファイルを 1 枠使います）
            </span>
          </li>
          <li>
            下の<strong>「接続」</strong>を押し、ブラウザのダイアログで
            キーボードを選ぶ
          </li>
          <li>
            接続できたら、キーボードを
            <strong>元のプロファイル（普段使っている PC）に戻す</strong>
            <span className="muted">
              これでキー入力は本来の PC に流れ、こちらにはフィードだけが届きます。
              ここで初めて盤面が動き出します。
            </span>
          </li>
        </ol>
        <div className="lp-actions">
          <button
            className="lp-primary"
            onClick={onConnect}
            disabled={!supported || connecting || connected}
          >
            {connected ? "接続済み" : connecting ? "接続中…" : "接続"}
          </button>
          {canReconnect && !connected && (
            <button onClick={onReconnect} disabled={connecting}>
              再接続
            </button>
          )}
        </div>
        <p className="lp-note muted">
          接続はキーの<strong>押下ハイライト</strong>と<strong>レイヤー表示</strong>
          のためのものです。盤面そのもの（キー配列と刻印）は次の「キーマップ」で決まるので、
          接続しなくても表示できます。
        </p>
      </section>

      {/* ---- 2. keymap ---- */}
      <section className="lp-section">
        <h2 className="lp-h2">
          <span className="lp-num">2</span> キーマップを用意する
        </h2>
        <p className="lp-note">
          盤面を描くにはキーマップが要ります。
          <strong>JSON をインポートするのが確実な方法</strong>です。
          一度読み込めばこのブラウザに保存され、
          <strong>次回以降は接続も同期もなしで盤面が出ます</strong>。
        </p>
        <div className="lp-cards">
          <div className="lp-card lp-card-hero">
            <div className="lp-card-title">
              JSON をインポート <span className="lp-badge">確実</span>
            </div>
            <p className="lp-card-body">
              次のどちらのファイルでも読み込めます（形式は自動判別）。
            </p>
            <ul className="lp-limits lp-tight">
              <li>
                <strong>Torabo Float のキャッシュ</strong>
                <br />
                <code className="lp-inline-code">
                  %APPDATA%\io.github.tak-2025.torabo-float\keymap-cache.json
                </code>
                <br />
                <span className="muted">
                  デスクトップ版 Torabo Float が作るファイル。下の「エクスポート」で
                  書き出したファイルも同じ形式です。物理レイアウトまで入っているので
                  <strong>これが一番確実</strong>。
                </span>
              </li>
              <li>
                <strong>Torabo Studio のバックアップ</strong>
                <br />
                <code className="lp-inline-code">torabo-backup-*.json</code>
                <br />
                <span className="muted">
                  Torabo Studio の「バックアップ」パネルで保存したファイル。
                  キー配列（物理レイアウト）が含まれないので、標準の torabo-tsuki
                  配列で描画します。version 4 以降ならキー名も正しく出ます。
                </span>
              </li>
            </ul>
            <button className="lp-primary" onClick={onImport}>
              JSON をインポート
            </button>
          </div>

          <div className="lp-card">
            <div className="lp-card-title">RPC 同期（うまくいけば自動）</div>
            <p className="lp-card-body">
              接続中なら ZMK Studio の RPC でキーボードから直接取得できます。
              成功すればファイルは不要ですが、BLE 経由なので
              <strong>数十秒かかり、失敗することもあります</strong>。
              失敗しても押下ハイライトには影響しません — その場合は左の JSON
              インポートを使ってください。
            </p>
            <button onClick={onSync} disabled={!connected || syncing}>
              {syncing
                ? "同期中…"
                : connected
                ? "いま同期する"
                : "接続してから使えます"}
            </button>
          </div>

          <div className="lp-card">
            <div className="lp-card-title">エクスポート（他の人に渡す）</div>
            <p className="lp-card-body">
              いま表示しているキーマップを <code>keymap-cache.json</code>{" "}
              として書き出します。このファイルを渡せば、相手は
              <strong>キーボードなしでも同じ盤面</strong>を表示できます
              （押下ハイライトには相手側の接続が必要です）。
            </p>
            <button onClick={onExport} disabled={!hasKeymap}>
              {hasKeymap ? "エクスポート" : "キーマップがありません"}
            </button>
          </div>
        </div>
        {importNote && <p className="lp-warn">{importNote}</p>}
      </section>

      {/* ---- 3. how to display ---- */}
      <section className="lp-section">
        <h2 className="lp-h2">
          <span className="lp-num">3</span> 盤面の表示方法をえらぶ
        </h2>
        <div className="lp-cards">
          <div className="lp-card">
            <div className="lp-card-title">このページで表示</div>
            <p className="lp-card-body">
              いちばん手軽。このタブがそのまま盤面になります。
              ほかのウィンドウの後ろに隠れます。
            </p>
            <button onClick={onShowHere}>このページで表示</button>
          </div>

          <div className="lp-card">
            <div className="lp-card-title">最小ウィンドウで開く</div>
            <p className="lp-card-body">
              URL バーもタブもない小さな別ウィンドウに盤面だけを出します。
              <strong>接続はこのタブが持ったまま</strong>で、
              入力は小窓へ中継されます。最前面には固定されません。
            </p>
            <button onClick={onOpenPopup} disabled={!launch.ready}>
              最小ウィンドウで開く
            </button>
          </div>

          <div className="lp-card lp-card-hero">
            <div className="lp-card-title">
              常に最前面で開く <span className="lp-badge">おすすめ</span>
            </div>
            <p className="lp-card-body">
              Document Picture-in-Picture を使い、
              <strong>ほかのウィンドウより常に手前</strong>に浮く小窓に盤面を出します。
              デスクトップ版 Torabo Float にいちばん近い使い心地です。
              <br />
              <span className="muted">
                背景は透過できません（不透明な小窓になります）。透過が必要なら
                OBS のブラウザソースを使ってください。
              </span>
            </p>
            <button
              className="lp-primary"
              onClick={onOpenPip}
              disabled={!!pipReason || !launch.ready}
            >
              常に最前面で開く
            </button>
            {pipReason && <div className="lp-warn">利用不可: {pipReason}</div>}
          </div>
        </div>
        {!launch.ready && (
          <p className="lp-warn">
            キーマップがまだありません。上の 2
            で JSON をインポートすると別ウィンドウで開けるようになります。
          </p>
        )}
        {launchNote && <p className="lp-warn">{launchNote}</p>}
        <p className="lp-note muted">
          いずれの方法でも、盤面だけの表示から <kbd>h</kbd>{" "}
          キー（または左上隅の小さなハンドル）でこの操作パネルに戻れます。
        </p>
      </section>

      {/* ---- 4. OBS ---- */}
      <section className="lp-section">
        <h2 className="lp-h2">
          <span className="lp-num">4</span> OBS で配信オーバーレイにする
        </h2>
        <p className="lp-note">
          背景は完全に透過しているので、<strong>カスタム CSS は不要</strong>です。
          OBS のブラウザソースに次の URL を入れるだけで、そのまま他のソースに
          重ねられます。
        </p>
        <pre className="lp-code">{obsUrl}</pre>
        <ol className="lp-steps">
          <li>OBS → ソース → <strong>ブラウザ</strong>を追加</li>
          <li>URL に上のアドレスを入れ、幅・高さを盤面に合わせる</li>
          <li>
            「<strong>表示されていないときにソースをシャットダウン</strong>」は
            <strong>オフ</strong>（オンだと接続が切れます）
          </li>
          <li>
            接続はソースを右クリック →<strong>「操作」(Interact)</strong> から。
            まず <code>?chrome=0</code> を付けずに読み込んで接続し、
            <kbd>h</kbd> で操作パネルを消すのが確実です
            （リロードすると Web Bluetooth の許可が失われます）
          </li>
        </ol>
        <table className="lp-table">
          <thead>
            <tr>
              <th>パラメータ</th>
              <th>値</th>
              <th>説明</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><code>theme</code></td>
              <td>pale / dark / sakura / mint / contrast</td>
              <td>配色</td>
            </tr>
            <tr>
              <td><code>legend</code></td>
              <td>jis / us</td>
              <td>キーキャップ刻印</td>
            </tr>
            <tr>
              <td><code>scale</code></td>
              <td>auto / 50〜200</td>
              <td>表示倍率（%）。auto は枠にフィット</td>
            </tr>
            <tr>
              <td><code>opacity</code></td>
              <td>30〜100</td>
              <td>不透明度（%）</td>
            </tr>
            <tr>
              <td><code>chrome</code></td>
              <td>0 / 1</td>
              <td>0 で操作パネルを隠し盤面だけにする（説明ページも出ません）</td>
            </tr>
          </tbody>
        </table>
      </section>

      {/* ---- download ---- */}
      <section className="lp-section">
        <h2 className="lp-h2">ダウンロードして使う（オフライン可）</h2>
        <p className="lp-note">
          このページ全体を <strong>HTML ファイル 1 枚</strong>にまとめたものを
          配布しています。JS も CSS も中に埋め込んであるので、
          <strong>ダウンロードしてダブルクリックするだけ</strong>で、
          ここと同じものがそのまま動きます。サーバも Node.js も要りません。
          キーボードへの接続（Web Bluetooth）も <code>file://</code> のまま動作することを
          実機で確認済みです。
        </p>
        <div className="lp-actions">
          <a className="lp-primary lp-dl" href={SINGLE_FILE_URL} download>
            torabo-float-web.html をダウンロード
          </a>
        </div>
        <ul className="lp-limits lp-tight">
          <li>
            <strong>ネットが無くても使えます。</strong>
            一度落としてしまえば、以降このページを開く必要はありません。
            USB メモリに入れて別の PC で開く、といった使い方もできます。
          </li>
          <li>
            <strong>そのまま人に渡せます。</strong>
            帰属表記（NOTICE）はファイル内に埋め込み済みなので、
            この 1 枚を配るだけでライセンス上の要件を満たします。
          </li>
          <li>
            <strong>設定とキーマップはファイル単位で保存されます。</strong>
            <code>file://</code> で開いた場合の保存先はこのページ（https）とは別枠なので、
            ローカル版では改めて JSON をインポートしてください。
          </li>
          <li>
            <strong>OBS のブラウザソースにはローカルファイルも指定できます</strong>
            （「ローカルファイル」にチェックを入れてこの HTML を選択）。
            ただし <code>?chrome=0</code> は URL パラメータなので使えません —
            <kbd>h</kbd> キーで操作パネルを隠してください。
          </li>
        </ul>
      </section>

      {/* ---- limits ---- */}
      <section className="lp-section">
        <h2 className="lp-h2">既知の制約</h2>
        <ul className="lp-limits">
          <li>
            <strong>Chrome / Edge のデスクトップ版のみ。</strong>
            iOS / iPadOS の Safari と Firefox は Web Bluetooth 非対応です。
          </li>
          <li>
            <strong>ページを読み込むたびにデバイス選択が必要。</strong>
            Web Bluetooth の許可はセッション単位なので、自動再接続はできません。
            リロードせずに使い続けるのが前提です。
          </li>
          <li>
            <strong>BLE プロファイルを 1 枠使います。</strong>
            空きがない場合はどれかを解放してください。
          </li>
          <li>
            <strong>背景の透過は OBS のブラウザソース内だけ。</strong>
            通常のブラウザウィンドウや最前面（PiP）ウィンドウは不透明です。
            クリックスルーもできません。
          </li>
          <li>
            <strong>RPC 同期は保証されません。</strong>
            ZMK の RPC は BLE の INDICATE で 20 バイトずつ往復するため、
            キーマップのような大きな応答はブラウザ経由だと数十秒かかり、
            環境によっては完了しません。
            <strong>JSON インポートが確実な経路</strong>です。
          </li>
          <li>
            Mod-Tap / Sticky Shift の押下状態は追跡していません
            （デスクトップ版と同じ制約）。
          </li>
        </ul>
      </section>

      {/* ---- license ---- */}
      <section className="lp-section">
        <h2 className="lp-h2">ライセンス</h2>
        <p className="lp-note">
          本アプリは <strong>Apache License 2.0</strong> です。ZMK Studio /
          Torabo-Studio 由来のコードを含むため、再配布する際は帰属表記
          （NOTICE）の保持が必要です。上でダウンロードできる単一 HTML（
          <code className="lp-inline-code">torabo-float-web.html</code>
          ）にはこの表記をあらかじめ埋め込んであるので、
          <strong>ファイル単体で他の人に渡しても問題ありません</strong>。
        </p>
        <details className="lp-details">
          <summary>NOTICE の全文を見る</summary>
          <pre className="lp-code lp-notice">{noticeText}</pre>
        </details>
        <p className="lp-note muted">
          ライセンス全文:{" "}
          <a
            href="https://www.apache.org/licenses/LICENSE-2.0"
            target="_blank"
            rel="noreferrer"
          >
            Apache License 2.0
          </a>{" "}
          / リポジトリ（LICENSE・NOTICE 原本）:{" "}
          <a
            href="https://github.com/tak-2025/Torabo-Float/tree/main/web"
            target="_blank"
            rel="noreferrer"
          >
            tak-2025/Torabo-Float (web/)
          </a>
        </p>
      </section>

      <footer className="lp-foot muted">
        Apache-2.0 / 本プロジェクトは ZMK Project とは提携・承認関係にありません。
      </footer>
    </div>
  );
}
