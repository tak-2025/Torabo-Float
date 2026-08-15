// Live-feed state hook.
//
// Copied from Torabo-Float (src/hooks/useLiveFeed.ts). The ONLY change is the
// event source: Tauri's `listen("live_feed_event")` becomes `on(...)` from the
// Web Bluetooth transport in ../ble. Both return an unlisten function, but the
// web one is synchronous, so the promise-tracking dance the Tauri version
// needed collapses into a plain array of unlisteners.
//
// Owns the pressed-position set and the current layer fields.
import { useCallback, useEffect, useRef, useState } from "react";
import { on, Unlisten } from "../ble";
import {
  decodeLiveFeed,
  EvtType,
  LiveFeedEvent,
  POSITION_NONE,
} from "../liveFeed";

export interface LiveState {
  highestLayer: number; // layer id
  activeLayout: number;
  layerMask: number;
  keymapCrc: number;
}

const ZERO: LiveState = {
  highestLayer: 0,
  activeLayout: 0,
  layerMask: 0,
  keymapCrc: 0,
};

export function useLiveFeed(
  onEvent?: (e: LiveFeedEvent) => void,
  onDisconnect?: () => void
) {
  const [pressed, setPressed] = useState<Set<number>>(new Set());
  const [layer, setLayer] = useState<LiveState>(ZERO);

  // Keep callbacks in refs so the listener effect can register once ([] deps)
  // yet always call the latest closures (fresh `cache`, etc.).
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onDisconnectRef = useRef(onDisconnect);
  onDisconnectRef.current = onDisconnect;

  const applyEvent = useCallback((e: LiveFeedEvent) => {
    if (e.evtType === EvtType.KEY && e.position !== POSITION_NONE) {
      setPressed((prev) => {
        const next = new Set(prev);
        if (e.pressed) next.add(e.position);
        else next.delete(e.position);
        return next;
      });
    }
    // KEY / LAYER / SNAPSHOT all carry the current layer fields.
    setLayer({
      highestLayer: e.highestLayer,
      activeLayout: e.activeLayout,
      layerMask: e.layerMask,
      keymapCrc: e.keymapCrc,
    });
    onEventRef.current?.(e);
  }, []);

  useEffect(() => {
    const unlisteners: Unlisten[] = [
      on("live_feed_event", (payload) => {
        const decoded = decodeLiveFeed(payload);
        if (decoded) applyEvent(decoded);
      }),
      on("connection_disconnected", () => {
        setPressed(new Set());
        onDisconnectRef.current?.();
      }),
    ];
    return () => unlisteners.forEach((u) => u());
  }, [applyEvent]);

  const resetPressed = useCallback(() => setPressed(new Set()), []);

  return { pressed, layer, applyEvent, resetPressed };
}
