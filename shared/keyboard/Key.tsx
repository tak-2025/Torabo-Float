// Adapted from zmk-studio/src/keyboard/Key.tsx to plain CSS (no Tailwind/daisyUI).
//
// Float is display-only: the react-aria / selection semantics are stripped. A key
// is a plain div (not a button) that shows a header (behavior short-name) and a
// centered child (the HID label), and gets a `pressed` accent when live-pressed.
import { PropsWithChildren } from "react";
import BehaviorShortNames from "./behavior-short-names.json";

interface KeyProps {
  pressed?: boolean;
  width: number;
  height: number;
  oneU: number;
  header?: string;
  /** What the hold half of a hold-tap does, appended to the header (e.g. the
   *  "2" of "LT 2"). The body shows the tap key, so without this the hold half
   *  would be invisible on the board. */
  hold?: string;
  /** Draw the key recessed. Used for the behaviors that do nothing of their own
   *  (&trans falls through to the layer below, &none swallows the press): they
   *  are the background of a layer, not part of what it does, and at a glance
   *  the eye should skip them to find the keys that matter. */
  muted?: boolean;
}

interface BehaviorShortName {
  short?: string;
}

const MAX_HEADER_LENGTH = 9;
const shortNames: Record<string, BehaviorShortName> = BehaviorShortNames;

// Ported verbatim from Key.tsx: short-name overrides, then truncation.
const shortenHeader = (header: string | undefined) => {
  if (typeof header === "undefined") {
    return "";
  }
  // Empty string is a valid header (behaviors we don't want a header for), which
  // is falsy — so we use an undefined check here.
  if (typeof shortNames[header]?.short !== "undefined") {
    return shortNames[header].short;
  } else if (header.length > MAX_HEADER_LENGTH) {
    const words = header.split(/[\s,-]+/);
    const lettersPerWord = Math.trunc(MAX_HEADER_LENGTH / words.length);
    return words.map((word) => word.substring(0, lettersPerWord)).join("");
  } else {
    return header;
  }
};

export const Key = ({
  pressed = false,
  width,
  height,
  oneU,
  header,
  hold,
  muted = false,
  children,
}: PropsWithChildren<KeyProps>) => {
  const pixelWidth = width * oneU - 2;
  const pixelHeight = height * oneU - 2;

  // Shorten first, then append: the short name is looked up by the exact
  // display name, so "Mod-Tap Shft" would never match the table.
  const headerText = [shortenHeader(header), hold].filter(Boolean).join(" ");

  // A live press wins over the recessed look — a pressed &trans should still
  // read as pressed.
  const state = pressed ? " key-pressed" : muted ? " key-muted" : "";

  return (
    <div
      className={`key${state}`}
      style={{
        width: `${pixelWidth}px`,
        height: `${pixelHeight}px`,
      }}
    >
      <div className="key-header">{headerText}</div>
      <div className="key-body">{children}</div>
    </div>
  );
};
