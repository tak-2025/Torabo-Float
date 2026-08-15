// Cross-window live-feed bridge (BroadcastChannel).
//
// Launch mode (b) — 「最小ウィンドウで開く」 — opens a second *document* via
// window.open(). A second document cannot share the first one's GATT
// connection: a Web Bluetooth grant belongs to the document that asked for it,
// and re-asking would need the keyboard to be advertising again (i.e. the whole
// three-step profile dance a second time).
//
// So the popup does not connect at all. The opener keeps the single BLE link
// and rebroadcasts every raw live_feed frame on a same-origin BroadcastChannel;
// the popup decodes those frames with the very same `decodeLiveFeed()` and
// renders the board. Same division of labour as launch mode (c): connection in
// the opener, pixels in the child window.
//
// The keymap travels the same way. It is normally in localStorage (which the
// popup could read itself), but replying to `hello` with the opener's in-memory
// cache also covers the case where the write failed (quota / privacy mode).

import type { CachedKeymap } from "./keymap/cache";

const CHANNEL_NAME = "torabo-float-web";

export type BridgeMessage =
  /** child → opener: "I just opened, send me what you have" */
  | { t: "hello" }
  /** opener → child: one raw 16-byte live_feed frame */
  | { t: "feed"; bytes: number[] }
  /** opener → child: the current keymap cache (may be null) */
  | { t: "cache"; cache: CachedKeymap | null };

/** True when this document is a bridge child (`?bridge=1`). */
export function isBridgeChild(search = window.location.search): boolean {
  return new URLSearchParams(search).get("bridge") === "1";
}

/**
 * Open the shared channel. Returns null where BroadcastChannel is missing or
 * blocked — the caller then simply degrades to a static board.
 */
export function openChannel(): BroadcastChannel | null {
  try {
    return new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return null;
  }
}
