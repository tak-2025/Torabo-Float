// Document Picture-in-Picture — the closest a browser gets to Torabo-Float's
// always-on-top desktop window.
//
// A PiP window is a real, separate `Window`/`Document` that the OS keeps above
// every other window. That is the one desktop affordance the web platform *can*
// give us (transparency and click-through it cannot). Chrome / Edge 116+.
//
// Two things about it are easy to get wrong and both are handled here:
//
//   1. The PiP document starts EMPTY — no stylesheet is inherited from the
//      opener, not even the one that produced the element you are about to move
//      into it. `copyStyles()` serialises every rule of the opener's
//      `document.styleSheets` (plus `adoptedStyleSheets`) into a `<style>` tag.
//      Vite serves CSS as an injected `<style>` in dev and a same-origin
//      `<link>` in a build, so `cssRules` is readable in both; the `href`
//      fallback covers a cross-origin sheet, which we do not currently have.
//
//   2. CSS custom properties are set on the OPENER's `documentElement`
//      (`--ui-alpha`) along with `data-theme`. Copying the rules alone would
//      give an unthemed board, so `syncPipTheme()` mirrors those onto the PiP
//      root as well — and must be re-run whenever the settings change.
//
// The BLE link deliberately stays in the opener: React renders the board into
// the PiP document through `createPortal`, so closing the PiP window unmounts a
// portal and nothing else. The GATT connection (and the Web Bluetooth grant,
// which cannot survive a document swap) is untouched.

export interface PipOptions {
  width: number;
  height: number;
}

interface DocumentPictureInPictureApi extends EventTarget {
  readonly window: Window | null;
  requestWindow(options?: Partial<PipOptions>): Promise<Window>;
}

declare global {
  interface Window {
    documentPictureInPicture?: DocumentPictureInPictureApi;
  }
}

/** True when this browser exposes the Document Picture-in-Picture API. */
export function pipSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "documentPictureInPicture" in window &&
    typeof window.documentPictureInPicture?.requestWindow === "function"
  );
}

/** Why PiP is unavailable, in Japanese, for the disabled button's caption. */
export function pipUnavailableReason(): string | null {
  if (pipSupported()) return null;
  if (typeof window !== "undefined" && !window.isSecureContext) {
    return "HTTPS または localhost でないと利用できません";
  }
  return "このブラウザは非対応です（Chrome / Edge 116 以降が必要）";
}

/**
 * Serialise the opener's stylesheets into the target document.
 *
 * Exported so it can be unit-checked without actually opening a PiP window
 * (which requires a user gesture and cannot be driven from automation).
 * Returns the number of sheets copied.
 */
export function copyStyles(target: Document, source: Document = document): number {
  let copied = 0;

  for (const sheet of Array.from(source.styleSheets)) {
    let cssText: string | null = null;
    try {
      cssText = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join("\n");
    } catch {
      // Cross-origin sheet: rules are unreadable, so re-link it instead.
      if (sheet.href) {
        const link = target.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        target.head.appendChild(link);
        copied += 1;
      }
      continue;
    }
    const style = target.createElement("style");
    style.textContent = cssText;
    target.head.appendChild(style);
    copied += 1;
  }

  // Constructable stylesheets (not used today, but free to support and
  // invisible in `document.styleSheets` on some engines).
  const adopted = (source as Document & { adoptedStyleSheets?: CSSStyleSheet[] })
    .adoptedStyleSheets;
  if (adopted && adopted.length > 0) {
    for (const sheet of adopted) {
      try {
        const style = target.createElement("style");
        style.textContent = Array.from(sheet.cssRules)
          .map((r) => r.cssText)
          .join("\n");
        target.head.appendChild(style);
        copied += 1;
      } catch {
        /* unreadable — skip */
      }
    }
  }

  return copied;
}

/**
 * Mirror the opener's runtime theme state (`data-theme` + `--ui-alpha`) onto a
 * PiP document root. Idempotent; call again on every settings change.
 */
export function syncPipTheme(
  target: Document,
  theme: string,
  opacityPercent: number
): void {
  target.documentElement.lang = "ja";
  target.documentElement.dataset.theme = theme;
  target.documentElement.style.setProperty(
    "--ui-alpha",
    String(opacityPercent / 100)
  );
}

export interface PipHandle {
  win: Window;
  /** The element React should portal the board into. */
  host: HTMLElement;
}

/**
 * Open a PiP window prepared for the board. MUST be called from a user gesture.
 *
 * The returned `host` is an `.app.app-bare` container, i.e. exactly the DOM
 * shape the board-only overlay mode already uses, so the copied CSS applies
 * with no PiP-specific layout rules beyond `.pip-root`.
 */
export async function openPipWindow(
  opts: PipOptions,
  theme: string,
  opacityPercent: number
): Promise<PipHandle> {
  const api = window.documentPictureInPicture;
  if (!api) {
    throw new Error(pipUnavailableReason() ?? "PiP を利用できません");
  }

  const win = await api.requestWindow({
    width: Math.max(80, Math.round(opts.width)),
    height: Math.max(80, Math.round(opts.height)),
  });

  copyStyles(win.document);
  syncPipTheme(win.document, theme, opacityPercent);

  win.document.title = "Torabo Float";
  // Opaque backdrop: a PiP window floats over arbitrary desktop content, and
  // unlike OBS it cannot composite alpha, so the transparency contract is
  // deliberately overridden here (see `.pip-root` in styles.css).
  win.document.body.className = "pip-root";

  const host = win.document.createElement("div");
  host.className = "app app-bare";
  win.document.body.appendChild(host);

  return { win, host };
}
