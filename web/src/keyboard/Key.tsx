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
  children,
}: PropsWithChildren<KeyProps>) => {
  const pixelWidth = width * oneU - 2;
  const pixelHeight = height * oneU - 2;

  return (
    <div
      className={`key${pressed ? " key-pressed" : ""}`}
      style={{
        width: `${pixelWidth}px`,
        height: `${pixelHeight}px`,
      }}
    >
      <div className="key-header">{shortenHeader(header)}</div>
      <div className="key-body">{children}</div>
    </div>
  );
};
