import {
  CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import {
  AvailableDevice,
  close as bleClose,
  connect as bleConnect,
  listDevices,
  liveFeedReadSnapshot,
  liveFeedSubscribe,
} from "./ble";
import { decodeLiveFeed, formatLiveFeed, LiveFeedEvent } from "./liveFeed";
import { useLiveFeed } from "./hooks/useLiveFeed";
import { CachedKeymap, cacheRead, cacheWrite } from "./keymap/cache";
import { syncKeymap } from "./keymap/sync";
import { FloatBoard } from "./keyboard/FloatBoard";
import { KeyLayout } from "./keyboard/legends";
import { DiagPanel } from "./DiagPanel";

type ConnState = "disconnected" | "scanning" | "connecting" | "connected";
type View = "board" | "debug" | "diag";

const MAX_LOG = 50;

// --- ⚙ settings persistence (opacity / legend / theme) ---
const SETTINGS_KEY = "torabo-float-settings";
const MIN_ALPHA = 0.3;
const MAX_ALPHA = 1;

// Display-scale setting. "auto" keeps the fit-to-window behavior; a number is a
// percentage of the oneU=48px basis (100 = keys drawn at 48px). In manual mode
// the window is auto-resized to wrap the board (see the auto-fit effect below).
const MIN_SCALE = 50;
const MAX_SCALE = 200;
const SCALE_STEP = 5;
// Floor so a tiny board / narrow layout can't collapse the window to nothing.
const MIN_WIN_W = 280;
const MIN_WIN_H = 160;

type BoardScale = "auto" | number;

function clampScale(v: number): number {
  if (!Number.isFinite(v)) return 100;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(v)));
}

type ThemeId = "pale" | "dark" | "sakura" | "mint" | "contrast";
const THEME_IDS: ThemeId[] = ["pale", "dark", "sakura", "mint", "contrast"];

// Small round preview + the CSS custom properties each swatch button reads
// (--swatch-bg / --swatch-accent, see .settings-row .swatch in styles.css).
// Colors mirror each theme's --key-bg / --key-pressed-bg override.
const THEMES: { id: ThemeId; name: string; bg: string; accent: string }[] = [
  { id: "pale", name: "淡色", bg: "rgba(255, 255, 255, 0.9)", accent: "rgba(165, 216, 255, 0.95)" },
  { id: "dark", name: "ダーク", bg: "rgba(38, 42, 51, 0.95)", accent: "rgba(56, 189, 248, 0.92)" },
  { id: "sakura", name: "さくら", bg: "rgba(255, 241, 245, 0.95)", accent: "rgba(250, 162, 193, 0.95)" },
  { id: "mint", name: "ミント", bg: "rgba(236, 253, 245, 0.95)", accent: "rgba(110, 231, 183, 0.95)" },
  { id: "contrast", name: "くっきり", bg: "rgba(24, 24, 27, 0.95)", accent: "#fbbf24" },
];

interface FloatSettings {
  uiAlpha: number;
  keyLayout: KeyLayout; // which legend faces to draw (default JIS)
  theme: ThemeId; // key/pill color palette (default "pale")
  boardScale: BoardScale; // "auto" fit-to-window, or a percent 50–200
}

const DEFAULT_SETTINGS: FloatSettings = {
  uiAlpha: 1,
  keyLayout: "jis",
  theme: "pale",
  boardScale: "auto",
};

function parseBoardScale(v: unknown): BoardScale {
  if (v === "auto" || v === undefined || v === null) return "auto";
  const n = Number(v);
  return Number.isFinite(n) ? clampScale(n) : "auto";
}

function clampAlpha(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(MAX_ALPHA, Math.max(MIN_ALPHA, v));
}

function loadSettings(): FloatSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<FloatSettings>;
    return {
      uiAlpha: clampAlpha(parsed.uiAlpha ?? 1),
      keyLayout: parsed.keyLayout === "us" ? "us" : "jis",
      theme: THEME_IDS.includes(parsed.theme as ThemeId)
        ? (parsed.theme as ThemeId)
        : "pale",
      boardScale: parseBoardScale(parsed.boardScale),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function App() {
  const [conn, setConn] = useState<ConnState>("disconnected");
  const [devices, setDevices] = useState<AvailableDevice[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [error, setError] = useState<string>("");

  const [cache, setCache] = useState<CachedKeymap | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");
  const [stale, setStale] = useState(false);

  const [log, setLog] = useState<string[]>([]);
  const [view, setView] = useState<View>("board");

  const [showSettings, setShowSettings] = useState(false);
  const [uiAlpha, setUiAlphaState] = useState<number>(() => loadSettings().uiAlpha);
  const [keyLayout, setKeyLayout] = useState<KeyLayout>(
    () => loadSettings().keyLayout
  );
  const [theme, setTheme] = useState<ThemeId>(() => loadSettings().theme);
  const [boardScale, setBoardScale] = useState<BoardScale>(
    () => loadSettings().boardScale
  );
  // Last unscaled content box (px) reported by the board, for window auto-fit.
  const [contentSize, setContentSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });
  const onContentSize = useCallback((w: number, h: number) => {
    setContentSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
  }, []);

  const setUiAlpha = useCallback((v: number) => {
    setUiAlphaState(clampAlpha(v));
  }, []);

  // Percent value backing the manual slider — remembered even while in "auto"
  // so toggling 手動 restores the last chosen %, defaulting to 100.
  const scalePercent = typeof boardScale === "number" ? boardScale : 100;

  // Apply --ui-alpha + data-theme to the document root (the "container" the
  // header/board/pill chrome reads via var(--ui-alpha) and the [data-theme=…]
  // CSS overrides in styles.css) and persist the whole settings object, every
  // time any setting changes.
  useEffect(() => {
    document.documentElement.style.setProperty("--ui-alpha", String(uiAlpha));
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({ uiAlpha, keyLayout, theme, boardScale })
      );
    } catch {
      /* localStorage unavailable (privacy mode / quota) — non-fatal */
    }
  }, [uiAlpha, keyLayout, theme, boardScale]);

  // Manual display-scale → auto-resize the window to wrap the board. The stage
  // (`.floatboard-stage`) flex-grows to fill whatever the chrome leaves, so the
  // non-stage chrome height is exactly `innerHeight − stageHeight` right now;
  // adding the desired board box (content px × scale) to that measured chrome
  // gives the window size that makes the stage equal the board — robust to the
  // settings row / banners being open. Width chrome is just the body padding.
  // In "auto" mode we never touch the window (fit-to-window handles it).
  useEffect(() => {
    if (boardScale === "auto") return;
    if (contentSize.w <= 0 || contentSize.h <= 0) return;

    // Defer one frame so the DOM reflects the current chrome (e.g. settings row
    // just toggled) before we measure it.
    const raf = requestAnimationFrame(() => {
      const stage = document.querySelector(
        ".floatboard-stage"
      ) as HTMLElement | null;
      if (!stage) return;
      const stageRect = stage.getBoundingClientRect();
      const chromeW = Math.max(0, window.innerWidth - stageRect.width);
      const chromeH = Math.max(0, window.innerHeight - stageRect.height);

      const scale = boardScale / 100;
      const boardW = contentSize.w * scale;
      const boardH = contentSize.h * scale;

      const w = Math.max(MIN_WIN_W, Math.ceil(boardW + chromeW));
      const h = Math.max(MIN_WIN_H, Math.ceil(boardH + chromeH));

      getCurrentWindow()
        .setSize(new LogicalSize(w, h))
        .catch((e) => console.warn("[window] setSize failed", e));
    });
    return () => cancelAnimationFrame(raf);
  }, [boardScale, contentSize.w, contentSize.h, showSettings]);

  // Fresh cache for the long-lived event listener's staleness check.
  const cacheRef = useRef<CachedKeymap | null>(null);
  cacheRef.current = cache;

  // Log every event and flag staleness when the FW-reported CRC diverges from
  // the cached one. The app never computes the CRC itself — it only compares.
  const handleEvent = useCallback((e: LiveFeedEvent) => {
    setLog((prev) => [formatLiveFeed(e), ...prev].slice(0, MAX_LOG));
    const c = cacheRef.current;
    if (c && (e.keymapCrc >>> 0) !== (c.keymapCrc >>> 0)) {
      setStale(true);
    }
  }, []);

  const handleDisconnect = useCallback(() => {
    setConn("disconnected");
    setError("接続が切断されました");
  }, []);

  const { pressed, layer, applyEvent } = useLiveFeed(
    handleEvent,
    handleDisconnect
  );

  // Load the cache on startup so the board renders without connecting.
  useEffect(() => {
    cacheRead()
      .then((c) => {
        if (c) setCache(c);
      })
      .catch((e) => console.warn("[cache] read failed", e));
  }, []);

  const scan = useCallback(async () => {
    setError("");
    setConn("scanning");
    try {
      const found = await listDevices();
      setDevices(found);
      if (found.length > 0) setSelected(found[0].id);
      if (found.length === 0) setError("デバイスが見つかりません");
    } catch (e) {
      setError(String(e));
    } finally {
      setConn((c) => (c === "scanning" ? "disconnected" : c));
    }
  }, []);

  // Full RPC keymap sync. `snap` (from a fresh SNAPSHOT) is preferred for the
  // CRC/layout stored alongside; otherwise the latest live layer state is used.
  const runSync = async (snap: LiveFeedEvent | null) => {
    setSyncing(true);
    setSyncError("");
    try {
      const keymapCrc = snap ? snap.keymapCrc : layer.keymapCrc;
      const activeLayout = snap ? snap.activeLayout : layer.activeLayout;
      const result = await syncKeymap({ keymapCrc, activeLayout });
      await cacheWrite(result);
      setCache(result);
      setStale(false);
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  const doConnect = async () => {
    if (!selected) return;
    setError("");
    setSyncError("");
    setConn("connecting");
    try {
      await bleConnect(selected);
      await liveFeedSubscribe();
      setConn("connected");

      // Seed layer state from a SNAPSHOT so the board is correct immediately.
      let snap: LiveFeedEvent | null = null;
      try {
        snap = decodeLiveFeed(await liveFeedReadSnapshot());
        if (snap) applyEvent(snap);
      } catch {
        // best-effort; NOTIFY will fill state on the next event
      }

      // Auto-sync on first connect when there is no cache yet.
      if (!cacheRef.current) {
        await runSync(snap);
      }
    } catch (e) {
      setError(String(e));
      setConn("disconnected");
    }
  };

  const doDisconnect = async () => {
    try {
      await bleClose();
    } catch {
      /* ignore */
    }
    setConn("disconnected");
  };

  const statusColor =
    conn === "connected"
      ? "var(--status-connected)"
      : conn === "connecting" || conn === "scanning"
      ? "var(--status-busy)"
      : "var(--status-off)";

  const connLabel =
    conn === "connected"
      ? "接続済み"
      : conn === "connecting"
      ? "接続中…"
      : conn === "scanning"
      ? "スキャン中…"
      : "未接続";

  // The layer currently shown on the board — same lookup FloatBoard uses
  // internally, lifted here so the header pill can display it too.
  const activeLayerName = useMemo(() => {
    if (!cache || cache.layers.length === 0) return null;
    const l =
      cache.layers.find((x) => x.id === layer.highestLayer) ?? cache.layers[0];
    return l.name && l.name.length > 0 ? l.name : `#${l.id}`;
  }, [cache, layer.highestLayer]);

  return (
    <div className="app">
      <header className="header" data-tauri-drag-region>
        <span
          className="dot"
          style={{ background: statusColor }}
          data-tauri-drag-region
        />
        <span className="title layer-name" data-tauri-drag-region>
          {activeLayerName ?? "Torabo Float"}
        </span>
        <span className="conn-status" data-tauri-drag-region>
          {connLabel}
        </span>
        <span className="spacer" data-tauri-drag-region />
        <button
          className="ghost-btn"
          title="表示切替"
          onClick={() => setView((v) => (v === "debug" ? "board" : "debug"))}
        >
          {view === "debug" ? "ボード" : "ログ"}
        </button>
        <button
          className={`ghost-btn${view === "diag" ? " ghost-btn-active" : ""}`}
          title="診断モード"
          onClick={() => setView((v) => (v === "diag" ? "board" : "diag"))}
        >
          診断
        </button>
        {conn === "connected" && (
          <>
            <button
              className="ghost-btn"
              onClick={() => runSync(null)}
              disabled={syncing}
            >
              {syncing ? "同期中…" : "同期"}
            </button>
            <button className="ghost-btn" onClick={doDisconnect}>
              切断
            </button>
          </>
        )}
        <button
          className={`ghost-btn${showSettings ? " ghost-btn-active" : ""}`}
          title="設定"
          onClick={() => setShowSettings((s) => !s)}
        >
          ⚙
        </button>
        <button
          className="ghost-btn close"
          title="閉じる"
          onClick={() => getCurrentWindow().close()}
        >
          ×
        </button>
      </header>

      {showSettings && (
        <div className="settings-row">
          <span className="settings-label">不透明度</span>
          <input
            type="range"
            min={Math.round(MIN_ALPHA * 100)}
            max={Math.round(MAX_ALPHA * 100)}
            step={1}
            value={Math.round(uiAlpha * 100)}
            onChange={(e) => setUiAlpha(Number(e.target.value) / 100)}
          />
          <span className="settings-value">{Math.round(uiAlpha * 100)}%</span>
          <span className="settings-label">刻印</span>
          <div className="seg" role="group" aria-label="刻印">
            <button
              className={`seg-btn${keyLayout === "us" ? " seg-on" : ""}`}
              onClick={() => setKeyLayout("us")}
            >
              US
            </button>
            <button
              className={`seg-btn${keyLayout === "jis" ? " seg-on" : ""}`}
              onClick={() => setKeyLayout("jis")}
            >
              JIS
            </button>
          </div>
          <span className="settings-label">テーマ</span>
          <div className="swatches" role="group" aria-label="テーマ">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`swatch${theme === t.id ? " swatch-on" : ""}`}
                title={t.name}
                aria-label={t.name}
                aria-pressed={theme === t.id}
                style={
                  {
                    "--swatch-bg": t.bg,
                    "--swatch-accent": t.accent,
                  } as CSSProperties
                }
                onClick={() => setTheme(t.id)}
              />
            ))}
          </div>
          <span className="settings-label">サイズ</span>
          <div className="seg" role="group" aria-label="表示サイズ">
            <button
              className={`seg-btn${boardScale === "auto" ? " seg-on" : ""}`}
              onClick={() => setBoardScale("auto")}
            >
              自動
            </button>
            <button
              className={`seg-btn${boardScale !== "auto" ? " seg-on" : ""}`}
              onClick={() => setBoardScale(clampScale(scalePercent))}
            >
              手動
            </button>
          </div>
          {boardScale !== "auto" && (
            <>
              <input
                type="range"
                min={MIN_SCALE}
                max={MAX_SCALE}
                step={SCALE_STEP}
                value={scalePercent}
                onChange={(e) => setBoardScale(clampScale(Number(e.target.value)))}
              />
              <span className="settings-value">{scalePercent}%</span>
            </>
          )}
        </div>
      )}

      {stale && cache && (
        <div className="banner">
          <span>キーマップが変更されています — 再同期してください</span>
          <button
            className="banner-btn"
            onClick={() => runSync(null)}
            disabled={syncing || conn !== "connected"}
          >
            {syncing ? "同期中…" : "再同期"}
          </button>
        </div>
      )}

      {conn !== "connected" && (
        <div className="controls">
          <div className="row">
            <button
              onClick={scan}
              disabled={conn === "scanning" || conn === "connecting"}
            >
              {conn === "scanning" ? "スキャン中…" : "スキャン"}
            </button>
            <select
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              disabled={devices.length === 0}
            >
              {devices.length === 0 ? (
                <option value="">（デバイスなし）</option>
              ) : (
                devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))
              )}
            </select>
            <button
              onClick={doConnect}
              disabled={!selected || conn === "connecting"}
            >
              {conn === "connecting" ? "接続中…" : "接続"}
            </button>
          </div>
        </div>
      )}

      {(error || syncError) && (
        <div className="error">{syncError || error}</div>
      )}

      <main className="body">
        {view === "diag" ? (
          <DiagPanel connected={conn === "connected"} />
        ) : view === "debug" ? (
          <DebugLog log={log} layer={layer} />
        ) : cache ? (
          <FloatBoard
            cache={cache}
            activeLayout={layer.activeLayout}
            highestLayer={layer.highestLayer}
            pressed={pressed}
            keyLayout={keyLayout}
            boardScale={boardScale}
            onContentSize={onContentSize}
          />
        ) : (
          <div className="empty muted">
            <span className="empty-pill">
              キャッシュがありません。
              <br />
              接続すると自動で同期します。
            </span>
          </div>
        )}
      </main>
    </div>
  );
}

function DebugLog({
  log,
  layer,
}: {
  log: string[];
  layer: {
    highestLayer: number;
    activeLayout: number;
    layerMask: number;
    keymapCrc: number;
  };
}) {
  return (
    <div className="live">
      <div className="layerbar">
        <span className="badge">layer id={layer.highestLayer}</span>
        <span className="badge">
          mask=0b{(layer.layerMask >>> 0).toString(2)}
        </span>
        <span className="badge">layout={layer.activeLayout}</span>
        <span className="badge">
          crc=0x{(layer.keymapCrc >>> 0).toString(16)}
        </span>
      </div>
      <div className="logwrap">
        {log.length === 0 ? (
          <div className="muted">イベント待機中…</div>
        ) : (
          log.map((line, i) => (
            <div key={log.length - i} className="logline">
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
