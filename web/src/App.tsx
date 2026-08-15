// Torabo-Float Web — the browser build of the live board overlay.
//
// Differences from the desktop App.tsx, all of them forced by the platform:
//   * no window management (setSize / close / drag region) — the "window" is a
//     browser tab or an OBS browser source, sized outside the app,
//   * connection starts from a user gesture (Web Bluetooth requirement) and the
//     device chooser is the browser's, not ours,
//   * settings are resolvable from the URL so an OBS browser source can be
//     configured with no UI (see config.ts),
//   * the keymap has TWO sources: RPC sync (route A, unverified in a browser)
//     and JSON import (route B, always available). Route A failing must never
//     block route B — every RPC touchpoint below is wrapped so the worst case
//     is a dismissible notice.
import {
  CSSProperties,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  canReconnect,
  close as bleClose,
  connectedLabel,
  errText,
  isSupported,
  liveFeedReadSnapshot,
  liveFeedSubscribe,
  on as bleOn,
  reconnect as bleReconnect,
  requestAndConnect,
  rpcAvailable,
  rpcUnavailableReason,
} from "./ble";
import { BridgeMessage, isBridgeChild, openChannel } from "./bridge";
import { launchWindowSize } from "./boardSize";
import { Landing } from "./Landing";
import {
  openPipWindow,
  PipHandle,
  pipUnavailableReason,
  syncPipTheme,
} from "./pip";
import {
  BoardScale,
  clampOpacity,
  clampScale,
  MAX_OPACITY,
  MAX_SCALE,
  MIN_OPACITY,
  MIN_SCALE,
  resolveSettings,
  saveSettings,
  SCALE_STEP,
  Settings,
  settingsToQuery,
  ThemeId,
} from "./config";
import { decodeLiveFeed, formatLiveFeed, LiveFeedEvent } from "./liveFeed";
import { useLiveFeed } from "./hooks/useLiveFeed";
import {
  CachedKeymap,
  cacheClear,
  cacheRead,
  cacheWrite,
  exportCacheFile,
} from "./keymap/cache";
import { importKeymapFile } from "./keymap/import";
import { syncKeymap } from "./keymap/sync";
import { FloatBoard } from "./keyboard/FloatBoard";
import { DiagPanel } from "./DiagPanel";

type ConnState = "disconnected" | "connecting" | "connected";
type View = "board" | "debug" | "diag";

const MAX_LOG = 50;

// Theme swatch previews — colors mirror each theme's --key-bg / --key-pressed-bg
// override in styles.css.
const THEMES: { id: ThemeId; name: string; bg: string; accent: string }[] = [
  { id: "pale", name: "淡色", bg: "rgba(255, 255, 255, 0.9)", accent: "rgba(165, 216, 255, 0.95)" },
  { id: "dark", name: "ダーク", bg: "rgba(38, 42, 51, 0.95)", accent: "rgba(56, 189, 248, 0.92)" },
  { id: "sakura", name: "さくら", bg: "rgba(255, 241, 245, 0.95)", accent: "rgba(250, 162, 193, 0.95)" },
  { id: "mint", name: "ミント", bg: "rgba(236, 253, 245, 0.95)", accent: "rgba(110, 231, 183, 0.95)" },
  { id: "contrast", name: "くっきり", bg: "rgba(24, 24, 27, 0.95)", accent: "#fbbf24" },
];

const initial = resolveSettings();
/** `?bridge=1` — this document is a child window fed by its opener, not by BLE. */
const bridgeChild = isBridgeChild();

export function App() {
  const [conn, setConn] = useState<ConnState>("disconnected");
  const [error, setError] = useState<string>("");
  const [deviceName, setDeviceName] = useState<string>("");

  const [cache, setCache] = useState<CachedKeymap | null>(null);
  const [syncing, setSyncing] = useState(false);
  // Live progress text during a sync. A full keymap fetch over INDICATE takes
  // tens of seconds; without this the app looks frozen, which is what made the
  // sync feel broken even when it was merely slow.
  const [syncStage, setSyncStage] = useState("");
  // Route-A problems are a *notice*, never an error state: the board keeps
  // rendering from whatever cache route B (or a previous sync) provided.
  const [syncNote, setSyncNote] = useState("");
  const [stale, setStale] = useState(false);

  const [log, setLog] = useState<string[]>([]);
  const [view, setView] = useState<View>("board");
  const [showSettings, setShowSettings] = useState(false);
  // The explanation page. It is the default entry point — but never in
  // ?chrome=0, which exists precisely so an OBS browser source (or one of the
  // child windows below) lands straight on the board.
  const [showLanding, setShowLanding] = useState(
    initial.settings.chrome && !bridgeChild
  );
  const [launchNote, setLaunchNote] = useState("");
  const [pip, setPip] = useState<PipHandle | null>(null);
  // Runtime chrome visibility. Seeded from ?chrome=, but toggleable at runtime
  // (header 「隠す」 / the "h" key / the corner handle) so an OBS browser source
  // can be connected with the chrome up and then hidden WITHOUT a reload — a
  // reload would lose the Web Bluetooth grant, which requires a fresh gesture.
  const [chrome, setChrome] = useState<boolean>(initial.settings.chrome);

  const [settings, setSettings] = useState<Settings>(initial.settings);
  const urlLocked = initial.fromUrl;

  const patch = useCallback((p: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...p };
      saveSettings(next);
      return next;
    });
  }, []);

  // Apply --ui-alpha + data-theme to the document root. Background stays
  // transparent at every level (see styles.css) — that is what makes the OBS
  // browser source composite as an overlay.
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--ui-alpha",
      String(settings.opacity / 100)
    );
    document.documentElement.dataset.theme = settings.theme;
  }, [settings.opacity, settings.theme]);

  // "h" toggles the chrome. Ignored while typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "h" || e.ctrlKey || e.altKey || e.metaKey) return;
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return;
      setChrome((c) => !c);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Fresh cache for the long-lived event listener's staleness check.
  const cacheRef = useRef<CachedKeymap | null>(null);
  cacheRef.current = cache;

  const handleEvent = useCallback((e: LiveFeedEvent) => {
    setLog((prev) => [formatLiveFeed(e), ...prev].slice(0, MAX_LOG));
    const c = cacheRef.current;
    if (c && (e.keymapCrc >>> 0) !== (c.keymapCrc >>> 0)) setStale(true);
  }, []);

  const handleDisconnect = useCallback(() => {
    setConn((prev) => {
      if (prev === "disconnected") return prev;
      setError("接続が切断されました");
      return "disconnected";
    });
  }, []);

  const { pressed, layer, applyEvent } = useLiveFeed(
    handleEvent,
    handleDisconnect
  );

  // Load the cache on startup so the board renders without connecting — the
  // whole point of the overlay: OBS shows a board even with no BLE at all.
  useEffect(() => {
    cacheRead()
      .then((c) => {
        if (c) setCache(c);
      })
      .catch((e) => console.warn("[cache] read failed", e));
  }, []);

  // --- route A: keymap sync over RPC (best effort) --------------------------
  //
  // Contract: this function NEVER throws and NEVER changes the connection
  // state. Anything that goes wrong becomes `syncNote` text pointing at the
  // JSON-import fallback.
  const runSync = useCallback(
    async (snap: LiveFeedEvent | null): Promise<boolean> => {
      if (!rpcAvailable()) {
        setSyncNote(
          `キーマップ同期は利用できません（${
            rpcUnavailableReason() ?? "RPC なし"
          }）。JSON をインポートしてください。`
        );
        return false;
      }
      setSyncing(true);
      setSyncNote("");
      setSyncStage("キーマップ同期を開始しています…");
      try {
        const keymapCrc = snap ? snap.keymapCrc : layer.keymapCrc;
        const activeLayout = snap ? snap.activeLayout : layer.activeLayout;
        const result = await syncKeymap(
          { keymapCrc, activeLayout },
          setSyncStage
        );
        setCache(result);
        setStale(false);
        // A storage failure must not discard the freshly synced keymap: the
        // in-memory cache above is already live for this session.
        try {
          await cacheWrite(result);
        } catch (e) {
          setSyncNote(errText(e));
        }
        return true;
      } catch (e) {
        setSyncNote(
          `キーマップ同期に失敗しました（${errText(
            e
          )}）。JSON をインポートしてください。`
        );
        return false;
      } finally {
        setSyncing(false);
        setSyncStage("");
      }
    },
    [layer.keymapCrc, layer.activeLayout]
  );

  // --- connect --------------------------------------------------------------
  //
  // Split into "live feed" (required, decides the connection state) and
  // "keymap sync" (optional, decides only a notice). Called straight from the
  // button's onClick so requestDevice() still sees the user gesture.
  const openLink = useCallback(
    async (open: () => Promise<{ label: string }>) => {
      setError("");
      setSyncNote("");
      setConn("connecting");
      try {
        const dev = await open();
        setDeviceName(dev.label);
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

        // Auto-sync only when there is nothing to draw yet. Detached from the
        // connect path on purpose — a wedged RPC must not stall or undo a
        // working live feed.
        if (!cacheRef.current) void runSync(snap);
      } catch (e) {
        // requestDevice() rejects with NotFoundError when the user just closes
        // the chooser; that is not worth showing as an error.
        const msg = errText(e);
        if (!/User cancelled|chooser|NotFoundError: User/i.test(msg)) {
          setError(msg);
        }
        setConn("disconnected");
      }
    },
    [applyEvent, runSync]
  );

  const doConnect = () => openLink(requestAndConnect);
  const doReconnect = () => openLink(bleReconnect);

  const doDisconnect = async () => {
    setConn("disconnected");
    setError("");
    await bleClose().catch(() => {});
  };

  // --- route B: JSON import / export ---------------------------------------
  const fileRef = useRef<HTMLInputElement>(null);
  const [importNote, setImportNote] = useState("");

  const onPickFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setImportNote("");
    try {
      // The current cache is handed in because a Torabo Studio backup carries
      // no physical layouts (and, pre-v4, no behavior names): the converter
      // borrows them from what is already loaded before falling back to the
      // bundled torabo-tsuki geometry.
      const { cache: parsed, source, warnings } = await importKeymapFile(
        file,
        cacheRef.current
      );
      // A backup has no keymap CRC. Adopt the live one so the staleness banner
      // does not fire on the very next keystroke.
      const imported: CachedKeymap =
        source === "studio-backup" && conn === "connected"
          ? { ...parsed, keymapCrc: layer.keymapCrc >>> 0 }
          : parsed;

      setCache(imported);
      setStale(false);
      setSyncNote("");

      const label =
        source === "studio-backup"
          ? "Torabo Studio のバックアップを変換しました"
          : "読み込みました";
      const detail = `レイヤー ${imported.layers.length} / レイアウト ${imported.layouts.length}`;
      const warn = warnings.length ? ` ⚠ ${warnings.join(" / ")}` : "";

      try {
        await cacheWrite(imported);
      } catch (err) {
        setImportNote(`${label}（${detail}、保存は失敗: ${errText(err)}）${warn}`);
        return;
      }
      setImportNote(`${label}（${detail}）${warn}`);
    } catch (err) {
      setImportNote(`インポート失敗: ${errText(err)}`);
    }
  };

  const doExport = () => {
    if (cache) exportCacheFile(cache);
  };

  const doClearCache = () => {
    cacheClear();
    setCache(null);
    setImportNote("キャッシュを削除しました");
  };

  // --- cross-window bridge (launch mode b) ----------------------------------
  //
  // Opener: rebroadcast every raw live_feed frame plus the keymap, so a popup
  // that cannot own the GATT link still shows a live board.
  // Child: feed those frames into the exact same decoder the BLE path uses.
  const channelRef = useRef<BroadcastChannel | null>(null);
  const lastFrameRef = useRef<number[] | null>(null);

  useEffect(() => {
    const ch = openChannel();
    if (!ch) return;
    channelRef.current = ch;

    if (bridgeChild) {
      ch.onmessage = (ev: MessageEvent<BridgeMessage>) => {
        const msg = ev.data;
        if (msg?.t === "feed") {
          const decoded = decodeLiveFeed(msg.bytes);
          if (decoded) applyEvent(decoded);
        } else if (msg?.t === "cache" && msg.cache) {
          setCache(msg.cache);
        }
      };
      ch.postMessage({ t: "hello" } satisfies BridgeMessage);
    } else {
      // A child that opens later asks for the current state; replay the last
      // frame so its layer/pressed view is correct before the next keystroke.
      ch.onmessage = (ev: MessageEvent<BridgeMessage>) => {
        if (ev.data?.t !== "hello") return;
        ch.postMessage({
          t: "cache",
          cache: cacheRef.current,
        } satisfies BridgeMessage);
        if (lastFrameRef.current) {
          ch.postMessage({
            t: "feed",
            bytes: lastFrameRef.current,
          } satisfies BridgeMessage);
        }
      };
    }

    return () => {
      ch.onmessage = null;
      ch.close();
      channelRef.current = null;
    };
  }, [applyEvent]);

  // Opener-side tap on the raw transport. Subscribing to the bytes (rather than
  // re-encoding the decoded event) keeps the child's decode path identical.
  useEffect(() => {
    if (bridgeChild) return;
    return bleOn("live_feed_event", (bytes) => {
      lastFrameRef.current = bytes;
      channelRef.current?.postMessage({ t: "feed", bytes } satisfies BridgeMessage);
    });
  }, []);

  useEffect(() => {
    if (bridgeChild) return;
    channelRef.current?.postMessage({ t: "cache", cache } satisfies BridgeMessage);
  }, [cache]);

  // --- launch modes (b) popup / (c) always-on-top PiP -----------------------
  const boardZoom = typeof settings.scale === "number" ? settings.scale / 100 : 1;
  const launchSize = useMemo(
    () => launchWindowSize(cache, layer.activeLayout, boardZoom),
    [cache, layer.activeLayout, boardZoom]
  );

  /** URL for a child *document* (mode b): board only, fed over the bridge. */
  const childUrl = useCallback(() => {
    const base = window.location.origin + window.location.pathname;
    const q = new URLSearchParams(
      settingsToQuery({ ...settings, chrome: false }).slice(1)
    );
    q.set("chrome", "0");
    q.set("bridge", "1");
    return `${base}?${q.toString()}`;
  }, [settings]);

  const openPopup = useCallback(() => {
    setLaunchNote("");
    const { width, height } = launchSize;
    const w = window.open(
      childUrl(),
      "torabo-float-board",
      `popup,width=${width},height=${height}`
    );
    if (!w) {
      setLaunchNote(
        "小窓を開けませんでした。ブラウザのポップアップブロックを解除してください。"
      );
    }
  }, [childUrl, launchSize]);

  const openPip = useCallback(async () => {
    setLaunchNote("");
    try {
      const handle = await openPipWindow(
        launchSize,
        settings.theme,
        settings.opacity
      );
      // Closing the PiP window must only unmount a portal — the BLE link lives
      // in this document and is never touched.
      handle.win.addEventListener("pagehide", () => setPip(null), {
        once: true,
      });
      setPip(handle);
      setShowLanding(false);
    } catch (e) {
      setLaunchNote(`最前面ウィンドウを開けませんでした: ${errText(e)}`);
    }
  }, [launchSize, settings.theme, settings.opacity]);

  // Theme/opacity live on the document root, which the PiP document does not
  // inherit — mirror them on every change.
  useEffect(() => {
    if (pip) syncPipTheme(pip.win.document, settings.theme, settings.opacity);
  }, [pip, settings.theme, settings.opacity]);

  // Never leave an orphaned always-on-top window behind.
  useEffect(() => {
    if (!pip) return;
    return () => {
      try {
        pip.win.close();
      } catch {
        /* already gone */
      }
    };
  }, [pip]);

  const pipReason = pipUnavailableReason();

  // --- derived display ------------------------------------------------------
  const statusColor =
    conn === "connected"
      ? "var(--status-connected)"
      : conn === "connecting"
      ? "var(--status-busy)"
      : "var(--status-off)";

  const connLabel =
    conn === "connected"
      ? deviceName || connectedLabel() || "接続済み"
      : conn === "connecting"
      ? "接続中…"
      : "未接続";

  const activeLayerName = useMemo(() => {
    if (!cache || cache.layers.length === 0) return null;
    const l =
      cache.layers.find((x) => x.id === layer.highestLayer) ?? cache.layers[0];
    return l.name && l.name.length > 0 ? l.name : `#${l.id}`;
  }, [cache, layer.highestLayer]);

  const scalePercent =
    typeof settings.scale === "number" ? settings.scale : 100;
  const boardScale: BoardScale =
    typeof settings.scale === "number" ? settings.scale / 100 : "auto";

  const [copied, setCopied] = useState(false);
  const copyUrl = async () => {
    const url =
      window.location.origin +
      window.location.pathname +
      settingsToQuery({ ...settings, chrome });
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setImportNote(url); // clipboard blocked — at least show it
    }
  };

  const board = cache ? (
    <FloatBoard
      cache={cache}
      activeLayout={layer.activeLayout}
      highestLayer={layer.highestLayer}
      pressed={pressed}
      keyLayout={settings.legend}
      boardScale={boardScale}
    />
  ) : null;

  // Launch mode (c): the board is rendered into the PiP window's document via a
  // portal, so it keeps this component's props, state and BLE subscriptions —
  // closing the PiP window unmounts a portal and nothing else.
  const boardPortal = pip && board ? createPortal(board, pip.host) : null;

  // --- board-only overlay mode ---------------------------------------------
  // Nothing but the board is painted; the corner handle is invisible until
  // hovered so the chrome can be brought back without a reload.
  if (!chrome) {
    return (
      <div className="app app-bare">
        {boardPortal}
        <button
          className="chrome-handle"
          title="操作パネルを表示 (h)"
          aria-label="操作パネルを表示"
          onClick={() => setChrome(true)}
        />
        <main className="body">{pip ? null : board}</main>
      </div>
    );
  }

  return (
    <div className="app">
      {boardPortal}
      {/* Mounted unconditionally: both the ⚙ row and the landing page trigger
          it via fileRef, and the landing is shown with the ⚙ row collapsed. */}
      <input
        ref={fileRef}
        type="file"
        accept=".json,application/json"
        className="hidden-file"
        onChange={onPickFile}
      />
      <header className="header">
        <span className="dot" style={{ background: statusColor }} />
        <span className="title layer-name">
          {activeLayerName ?? "Torabo Float"}
        </span>
        <span className="conn-status">{connLabel}</span>
        <span className="spacer" />
        {pip && (
          <button
            className="ghost-btn ghost-btn-active"
            title="最前面ウィンドウを閉じてここに戻す"
            onClick={() => pip.win.close()}
          >
            最前面を閉じる
          </button>
        )}
        <button
          className={`ghost-btn${showLanding ? " ghost-btn-active" : ""}`}
          title="説明ページ"
          onClick={() => setShowLanding((s) => !s)}
        >
          説明
        </button>
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
              onClick={() => void runSync(null)}
              disabled={syncing}
              title="ZMK Studio RPC でキーマップを再取得"
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
          className="ghost-btn"
          title="操作パネルを隠す (h)"
          onClick={() => setChrome(false)}
        >
          隠す
        </button>
      </header>

      {showSettings && (
        <div className="settings-row">
          <span className="settings-label">不透明度</span>
          <input
            type="range"
            min={MIN_OPACITY}
            max={MAX_OPACITY}
            step={1}
            value={settings.opacity}
            onChange={(e) =>
              patch({ opacity: clampOpacity(Number(e.target.value)) })
            }
          />
          <span className="settings-value">{settings.opacity}%</span>
          <span className="settings-label">刻印</span>
          <div className="seg" role="group" aria-label="刻印">
            <button
              className={`seg-btn${settings.legend === "us" ? " seg-on" : ""}`}
              onClick={() => patch({ legend: "us" })}
            >
              US
            </button>
            <button
              className={`seg-btn${settings.legend === "jis" ? " seg-on" : ""}`}
              onClick={() => patch({ legend: "jis" })}
            >
              JIS
            </button>
          </div>
          <span className="settings-label">テーマ</span>
          <div className="swatches" role="group" aria-label="テーマ">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`swatch${settings.theme === t.id ? " swatch-on" : ""}`}
                title={t.name}
                aria-label={t.name}
                aria-pressed={settings.theme === t.id}
                style={
                  {
                    "--swatch-bg": t.bg,
                    "--swatch-accent": t.accent,
                  } as CSSProperties
                }
                onClick={() => patch({ theme: t.id })}
              />
            ))}
          </div>
          <span className="settings-label">サイズ</span>
          <div className="seg" role="group" aria-label="表示サイズ">
            <button
              className={`seg-btn${settings.scale === "auto" ? " seg-on" : ""}`}
              onClick={() => patch({ scale: "auto" })}
            >
              自動
            </button>
            <button
              className={`seg-btn${settings.scale !== "auto" ? " seg-on" : ""}`}
              onClick={() => patch({ scale: clampScale(scalePercent) })}
            >
              手動
            </button>
          </div>
          {settings.scale !== "auto" && (
            <>
              <input
                type="range"
                min={MIN_SCALE}
                max={MAX_SCALE}
                step={SCALE_STEP}
                value={scalePercent}
                onChange={(e) =>
                  patch({ scale: clampScale(Number(e.target.value)) })
                }
              />
              <span className="settings-value">{scalePercent}%</span>
            </>
          )}
          <button className="ghost-btn" onClick={copyUrl} title="この見た目を再現する URL">
            {copied ? "コピー済" : "URL コピー"}
          </button>
        </div>
      )}

      {showSettings && urlLocked.size > 0 && (
        <div className="note">
          URL パラメータで指定された項目があります（
          {[...urlLocked].join(", ")}
          ）。ここでの変更はこのページには反映されますが、リロードすると URL の値に戻ります。
        </div>
      )}

      {showSettings && (
        <div className="settings-row">
          <span className="settings-label">キーマップ</span>
          <button onClick={() => fileRef.current?.click()}>
            JSON インポート
          </button>
          <button onClick={doExport} disabled={!cache}>
            エクスポート
          </button>
          <button onClick={doClearCache} disabled={!cache}>
            キャッシュ削除
          </button>
          {importNote && <span className="settings-value wide">{importNote}</span>}
        </div>
      )}

      {syncing && (
        <div className="note note-busy">
          <span className="spinner" aria-hidden="true" />
          <span>{syncStage || "キーマップを同期中…"}</span>
          <span className="muted">
            BLE 経由なので数十秒かかることがあります。うまくいかないときは
            JSON インポートが確実です。
          </span>
        </div>
      )}

      {stale && cache && (
        <div className="banner">
          <span>キーマップが変更されています — 再同期してください</span>
          <button
            className="banner-btn"
            onClick={() => void runSync(null)}
            disabled={syncing || conn !== "connected"}
          >
            {syncing ? "同期中…" : "再同期"}
          </button>
        </div>
      )}

      {conn !== "connected" && !showLanding && (
        <div className="controls">
          <div className="row">
            <button onClick={doConnect} disabled={conn === "connecting"}>
              {conn === "connecting" ? "接続中…" : "接続"}
            </button>
            {canReconnect() && (
              <button onClick={doReconnect} disabled={conn === "connecting"}>
                再接続
              </button>
            )}
            <button className="link" onClick={() => setShowLanding(true)}>
              説明・接続手順を表示
            </button>
          </div>
        </div>
      )}

      {error && <div className="error">{error}</div>}
      {syncNote && (
        <div className="note note-warn">
          <span>{syncNote}</span>
          <button className="banner-btn" onClick={() => setSyncNote("")}>
            閉じる
          </button>
        </div>
      )}

      <main className="body">
        {showLanding ? (
          <Landing
            supported={isSupported()}
            connState={conn}
            canReconnect={canReconnect()}
            onConnect={doConnect}
            onReconnect={doReconnect}
            onImport={() => fileRef.current?.click()}
            onExport={doExport}
            onSync={() => void runSync(null)}
            hasKeymap={!!cache}
            syncing={syncing}
            onShowHere={() => setShowLanding(false)}
            onOpenPopup={openPopup}
            onOpenPip={() => void openPip()}
            pipReason={pipReason}
            launch={{ ...launchSize, ready: !!cache }}
            theme={settings.theme}
            baseUrl={window.location.origin + window.location.pathname}
            launchNote={launchNote}
            importNote={importNote}
          />
        ) : view === "diag" ? (
          <DiagPanel connected={conn === "connected"} />
        ) : view === "debug" ? (
          <DebugLog log={log} layer={layer} />
        ) : pip ? (
          <div className="empty muted">
            <span className="empty-pill">
              盤面は最前面ウィンドウに表示中です。
              <br />
              そのウィンドウを閉じるとここに戻ります。
            </span>
          </div>
        ) : cache ? (
          board
        ) : (
          <div className="empty muted">
            <span className="empty-pill">
              キーマップがありません。
              <br />
              <strong>JSON をインポート</strong>すると、接続しなくても盤面が出ます
              （読み込んだ内容はこのブラウザに保存され、次回以降は不要です）。
              <br />
              <span className="empty-actions">
                <button
                  className="lp-primary"
                  onClick={() => fileRef.current?.click()}
                >
                  JSON をインポート
                </button>
                {conn === "connected" && (
                  <button onClick={() => void runSync(null)} disabled={syncing}>
                    {syncing ? "同期中…" : "RPC で同期を試す"}
                  </button>
                )}
                <button className="link" onClick={() => setShowLanding(true)}>
                  どの JSON を使えばいい？
                </button>
              </span>
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
