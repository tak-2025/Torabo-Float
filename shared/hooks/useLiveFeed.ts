// Live-feed state hook.
//
// Owns the pressed-position set and the current layer fields. Subscribes
// through "~/events" — each target resolves that to its own adapter over the
// same on(name, handler): Unlisten contract (src/events.ts wraps Tauri's
// listen(); web/src/events.ts is the real multi-transport bus) — so this hook
// has never needed to know the transport.
import { useCallback, useEffect, useRef, useState } from "react";
import { on, Unlisten } from "~/events";
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
      // A frame the firmware sent must never be able to stop the feed. decode*
      // is total (it returns null instead of throwing — see liveFeed.ts's
      // forward-compat contract, live_feed.h:14), and this guard covers the
      // rest of the path: a render/state error raised by applyEvent would
      // otherwise escape into the transport's dispatch loop with the
      // subscription still delivering into a broken listener.
      on("live_feed_event", (payload) => {
        try {
          const decoded = decodeLiveFeed(payload);
          if (decoded) applyEvent(decoded);
        } catch (e) {
          console.error("[live_feed] dropping a frame that failed to apply", e);
        }
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
