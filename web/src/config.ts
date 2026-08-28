// Display settings, resolved from URL parameters first and localStorage second.
//
// The URL is the primary control surface for the OBS use case: a browser source
// has no UI to click, so everything the ⚙ row can change must also be settable
// as a query parameter. Precedence is therefore URL > localStorage > default —
// an explicit ?theme=dark always wins over whatever the last interactive
// session happened to save.
//
// Supported parameters (all optional):
//   ?theme=pale|dark|sakura|mint|contrast
//   ?legend=jis|us
//   ?scale=auto|50..200      (percent; "auto" fits the board to the viewport)
//   ?opacity=30..100         (percent, applied to the chrome + board)
//   ?chrome=0|1              (0 = board only: no header, settings, onboarding)

export type ThemeId = "pale" | "dark" | "sakura" | "mint" | "contrast";
export type LegendId = "us" | "jis";
export type BoardScale = "auto" | number;

export const THEME_IDS: ThemeId[] = [
  "pale",
  "dark",
  "sakura",
  "mint",
  "contrast",
];

export const MIN_SCALE = 50;
export const MAX_SCALE = 200;
export const SCALE_STEP = 5;
export const MIN_OPACITY = 30;
export const MAX_OPACITY = 100;

export interface Settings {
  theme: ThemeId;
  legend: LegendId;
  scale: BoardScale;
  /** 30–100 (percent). Stored as a percent so it round-trips with the URL. */
  opacity: number;
  /** false = board-only overlay mode (?chrome=0). Not persisted. */
  chrome: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "pale",
  legend: "jis",
  scale: "auto",
  opacity: 100,
  chrome: true,
};

const SETTINGS_KEY = "torabo-float-web-settings";

export function clampScale(v: number): number {
  if (!Number.isFinite(v)) return 100;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(v)));
}

export function clampOpacity(v: number): number {
  if (!Number.isFinite(v)) return MAX_OPACITY;
  return Math.min(MAX_OPACITY, Math.max(MIN_OPACITY, Math.round(v)));
}

function parseScale(v: unknown): BoardScale | undefined {
  if (v === "auto") return "auto";
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? clampScale(n) : undefined;
}

function parseTheme(v: unknown): ThemeId | undefined {
  return THEME_IDS.includes(v as ThemeId) ? (v as ThemeId) : undefined;
}

function parseLegend(v: unknown): LegendId | undefined {
  return v === "us" || v === "jis" ? v : undefined;
}

function parseOpacity(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? clampOpacity(n) : undefined;
}

/** The persisted half of the settings (chrome is URL-only, never stored). */
function loadStored(): Partial<Settings> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw) as Partial<Settings>;
    return {
      theme: parseTheme(p.theme),
      legend: parseLegend(p.legend),
      scale: parseScale(p.scale),
      opacity: parseOpacity(p.opacity),
    };
  } catch {
    return {};
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        theme: s.theme,
        legend: s.legend,
        scale: s.scale,
        opacity: s.opacity,
      })
    );
  } catch {
    /* localStorage unavailable (privacy mode / quota) — non-fatal */
  }
}

/** Which keys came from the URL, so the UI can say "URL 指定" and not fight it. */
export interface ResolvedSettings {
  settings: Settings;
  fromUrl: Set<keyof Settings>;
}

export function resolveSettings(search = window.location.search): ResolvedSettings {
  const q = new URLSearchParams(search);
  const stored = loadStored();
  const fromUrl = new Set<keyof Settings>();

  const pick = <K extends keyof Settings>(
    key: K,
    urlValue: Settings[K] | undefined
  ): Settings[K] => {
    if (urlValue !== undefined) {
      fromUrl.add(key);
      return urlValue;
    }
    return (stored[key] as Settings[K] | undefined) ?? DEFAULT_SETTINGS[key];
  };

  const chromeRaw = q.get("chrome");
  const chrome =
    chromeRaw === null ? undefined : !(chromeRaw === "0" || chromeRaw === "false");

  return {
    settings: {
      theme: pick("theme", parseTheme(q.get("theme"))),
      legend: pick("legend", parseLegend(q.get("legend"))),
      scale: pick("scale", parseScale(q.get("scale"))),
      opacity: pick("opacity", parseOpacity(q.get("opacity"))),
      chrome: pick("chrome", chrome),
    },
    fromUrl,
  };
}

/** Build the ?a=b&c=d string that reproduces `s` — shown by the ⚙ "URL をコピー". */
export function settingsToQuery(s: Settings): string {
  const q = new URLSearchParams();
  q.set("theme", s.theme);
  q.set("legend", s.legend);
  q.set("scale", String(s.scale));
  q.set("opacity", String(s.opacity));
  if (!s.chrome) q.set("chrome", "0");
  return "?" + q.toString();
}
