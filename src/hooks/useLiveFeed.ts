// Live-feed state hook.
//
// Owns the pressed-position set and the current layer fields, driven by the
// Tauri `live_feed_event` stream. This is also where the React half of the
// duplicate-event fix lives (the Rust half makes live_feed_subscribe
// idempotent): the effect registers each listener exactly once and its cleanup
// reliably unlistens even if it runs before the `listen()` promise resolves
// (React 18 StrictMode mounts/unmounts effects twice in dev).
import { useCallback, useEffect, useRef, useState } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
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
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    // If cleanup already ran by the time a listen() promise resolves, unlisten
    // immediately instead of leaking a second registration.
    const track = (p: Promise<UnlistenFn>) => {
      p.then((u) => {
        if (disposed) u();
        else unlisteners.push(u);
      });
    };

    track(
      listen<number[]>("live_feed_event", (ev) => {
        const decoded = decodeLiveFeed(ev.payload);
        if (decoded) applyEvent(decoded);
      })
    );

    track(
      listen("connection_disconnected", () => {
        setPressed(new Set());
        onDisconnectRef.current?.();
      })
    );

    return () => {
      disposed = true;
      unlisteners.forEach((u) => u());
    };
  }, [applyEvent]);

  const resetPressed = useCallback(() => setPressed(new Set()), []);

  return { pressed, layer, applyEvent, resetPressed };
}
