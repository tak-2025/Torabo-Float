#!/usr/bin/env node
/**
 * Regenerates this repo's keycap/legend assets (and the dynamic-macro codec)
 * from a torabo-studio checkout.
 *
 * torabo-studio is the single source for the keycap-face logic: the layout
 * legend table, the HID usage lookup + its data tables, the behavior name
 * tables, binding-face's "what should this key show" decision, and (new)
 * dynamic_macros/dmacConfig.ts, the codec Float needs next for macro-name
 * display (PLAN-translators.md フェーズ②/③). This repo used to hand-copy
 * these — legends.ts even carried a comment saying so — which is exactly the
 * kind of drift PLAN-translators.md exists to end. This script replaces that
 * with a mechanical copy of an explicit file list (NOT a directory walk:
 * most of shared/ is Float's own code, see PROTECTED below), and either
 * reports the drift (`--check`) or writes it and re-verifies the build.
 *
 * Unlike torabo-STUDIO-Android's translator (a whole-repo mirror), this is a
 * PARTIAL translator: Float only takes the keycap-face slice, and Studio's
 * src/<path> does not usually equal Float's shared/<path> 1:1 in general —
 * it happens to, for every file in MANIFEST below (see the `studio`/`float`
 * pair on each entry), which is what makes the mapping explicit rather than
 * derived.
 *
 * The three files that stayed genuinely different are NOT in the manifest:
 * `Key.tsx` and `HidUsageLabel.tsx` are real UI components (Studio: an
 * interactive daisyUI/Tailwind `<button>`; Float: a static plain-CSS `<div>`)
 * and `binding-face.test.ts` is a vitest file — Float has no JS test runner
 * (see PROTECTED, and the repo-wide note in package.json/README).
 * `binding-face.ts` itself WAS unified — see its own header comment in
 * torabo-studio for how the same file now serves both callers.
 *
 * Usage:
 *   node scripts/translate-from-studio.mjs [path-to-studio-checkout] [--check]
 *   npm run translate            # apply, then re-verify (tsc x2 + web build + root build)
 *   npm run translate:check      # dry run: report drift, exit 1 if any
 *
 * Default studio path: ../torabo-studio (siblings under the 4-repo SDK root).
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { copyFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const FLOAT_ROOT = resolve(HERE, "..");

// ---------------------------------------------------------------------------
// Manifest — explicit studio path -> float path pairs. Every path here is a
// single file (not a directory), because Float only takes a slice of Studio,
// not a mirror of it. Derived by diffing the two repos on 2026-09-03/04
// (PLAN-translators.md フェーズ②): everything below was either already
// identical (the four data/name tables) or became identical once
// torabo-studio grew the seams described in each entry's comment.
// ---------------------------------------------------------------------------

const MANIFEST = [
  {
    studio: "src/keyboard/legends.ts",
    float: "shared/keyboard/legends.ts",
    why: "Layout-aware legend table + param1 decoding. Used to carry a " +
      "hand-maintained \"4 copies, keep in sync\" pragma; Studio's header " +
      "now just says it's the source.",
  },
  {
    studio: "src/hid-usages.ts",
    float: "shared/hid-usages.ts",
    why: "HID usage label lookup. Only ever differed by comments/ordering.",
  },
  {
    studio: "src/hid-usage-name-overrides.json",
    float: "shared/hid-usage-name-overrides.json",
    why: "Already byte-identical.",
  },
  {
    studio: "src/keyboard-and-consumer-usage-tables.json",
    float: "shared/keyboard-and-consumer-usage-tables.json",
    why: "Already byte-identical (~460KB HID usage data, filtered from the " +
      "full USB HID usage tables).",
  },
  {
    studio: "src/keyboard/behavior-short-names.json",
    float: "shared/keyboard/behavior-short-names.json",
    why: "Already byte-identical.",
  },
  {
    studio: "src/keyboard/behavior-value-names.json",
    float: "shared/keyboard/behavior-value-names.json",
    why: "Already byte-identical.",
  },
  {
    studio: "src/keyboard/binding-face.ts",
    float: "shared/keyboard/binding-face.ts",
    why: "Unified across Studio/Float/Key-App (PLAN-translators.md " +
      "フェーズ② 前提作業): behavior lookup is the structural " +
      "BehaviorFaceSource type (not Studio's live GetBehaviorDetailsResponse " +
      "import), validateValue is inlined (Float has no behaviors/ dir), and " +
      "macroNames is a defaulted 4th param — Float's 3-arg caller " +
      "(FloatBoard.tsx) gets the old M<N> fallback for free.",
  },
  {
    studio: "src/keyboard/sizing.ts",
    float: "shared/keyboard/sizing.ts",
    why: "MAX_HOLD_LABEL/MAX_BODY_LABEL, extracted out of binding-face.ts as " +
      "a seam (PLAN-translators.md §2.5 / フェーズ③): Key-App's board is " +
      "phone-scale and needs shorter clip lengths than Studio/Float's, so " +
      "Key-App's translator protects its own copy of this one file (smaller " +
      "numbers) while binding-face.ts itself stays byte-identical across all " +
      "three repos. Float ships Studio's own defaults unchanged.",
  },
  {
    studio: "src/dynamic_macros/dmacConfig.ts",
    float: "shared/dynamic_macros/dmacConfig.ts",
    why: "Dynamic-macro wire codec. New to Float in this change — needed " +
      "next for macro-name display (フェーズ③). Self-contained (zero " +
      "imports), so no seam was needed to bring it over.",
  },
  {
    studio: "src/caps/toraboCaps.ts",
    float: "shared/caps/toraboCaps.ts",
    why: "Capability-descriptor codec (decodeCaps, featureInfo, moduleSlots, " +
      "centralSideFromHeader, CapsSide, ModuleKind, …). Needed for the diag " +
      "panel's declared-connector labels (shared/diagLayout.ts). Studio's " +
      "fwVersionString(caps) used to resolve its own i18n directly; it is " +
      "now a SEAM returning `string | null` (null = \"could not say\", " +
      "Studio's FirmwareInfoPanel localizes that itself) so this file stays " +
      "import-free and safe to copy verbatim — Float has no i18n of its own " +
      "to hand it.",
  },
];

/**
 * Never overwritten, never deleted, regardless of what studio has at the
 * matching path. Not load-bearing for the copy itself (MANIFEST above is an
 * explicit whitelist, not a directory walk, so nothing outside it is ever
 * touched) — this exists so the "why is X not translated" answer lives next
 * to the translator, per PLAN-translators.md's instruction to list Float's
 * shared/-but-not-translated files explicitly. Each entry is
 * `[repo-relative path, why]`; a path protects itself and everything under it.
 */
const PROTECTED = [
  ["src", "Tauri (desktop) target-specific code: App.tsx, ble.ts (Rust invoke transport), events.ts/link.ts (Tauri seam adapters), keymap/, styles.css, main.tsx. None of it exists in Studio."],
  ["web/src", "Web target-specific code: App.tsx, ble.ts (Web Bluetooth/Serial transport), Landing.tsx, config.ts, bridge.ts/pip.ts (the 3 display modes), boardSize.ts, keymap/, rpc/, styles.css, main.tsx. None of it exists in Studio."],
  ["src-tauri", "The Tauri/Rust desktop shell. Not part of Studio (a pure web app) at all."],
  ["docs", "Float documents itself (DESIGN-*.md, BUILD.md, PLAN-torabo-float.md)."],
  ["shared/liveFeed.ts", "The 16B live_feed frame decoder. Studio has no live overlay concept — this is Float's own invention, and currently Float's copy leads Key-App's (PLAN-translators.md フェーズ③ direction is Float→Key-App, not from Studio)."],
  ["shared/diag.ts", "Diagnostic-frame decoder, same reasoning as liveFeed.ts — Float-owned, no Studio equivalent."],
  ["shared/DiagPanel.tsx", "UI for the diag decoder above. Float-owned."],
  ["shared/diagLayout.ts", "Maps diag.ts rows to the connector names Feature.Modules declares (shared/caps/toraboCaps.ts, translated FROM studio — see that manifest entry above). Float-owned: Studio's own module-layout section (moduleLayout.ts) answers a different, wider question (a 2x2 grid built from the trackpad wire) and has no diag-row concept at all."],
  ["shared/hooks/useLiveFeed.ts", "Subscribes to live_feed via the per-target events.ts seam (~/events). Float-owned; no Studio equivalent."],
  ["shared/hooks/useDiag.ts", "Subscribes to diag + the 3 link.ts diagnostic commands. Float-owned; no Studio equivalent."],
  ["shared/keymap/types.ts", "CachedKeymap/CachedBehavior types — Float's read-only keymap cache shape. Studio has its own live RPC types (GetBehaviorDetailsResponse etc.); binding-face.ts bridges the two structurally (see BehaviorFaceSource) rather than sharing a type module."],
  ["shared/keymap/declaredModules.ts", "Turns a raw capability-descriptor read into CachedKeymap's moduleSlots/centralSide fields (decoded via the translated shared/caps/toraboCaps.ts). Float-owned: the caching/sync-time-read concern is Float's own, same as macroNames.ts, which this mirrors."],
  ["shared/keyboard/FloatBoard.tsx", "Float's keymap board renderer — reads the keymap cache and live_feed press state to draw the always-on-top overlay. Studio's analogous file (Keymap.tsx) is a full editor bound to live RPC state; genuinely different components, not a translation of each other."],
  ["shared/keyboard/PhysicalLayout.tsx", "Float owns its copy (Studio also has one) — not in scope for フェーズ②, which is the keycap-FACE slice only. boardSize.ts in web/ intentionally duplicates its geometry; see DESIGN-web.md."],
  ["shared/keyboard/Key.tsx", "Genuinely different component from Studio's: Studio's is an interactive daisyUI/Tailwind <button> (selected/onClick, for the keymap editor); Float's is a static plain-CSS <div> (pressed accent, for a read-only overlay). Diffed 2026-09-04 — not a comment-only difference, so left per-target rather than unified."],
  ["shared/keyboard/HidUsageLabel.tsx", "Genuinely different component from Studio's: Studio switches short/med/long labels via Tailwind container-query variants; Float's keys are a fixed size (oneU = 48px), so it renders the medium label directly with plain CSS. Diffed 2026-09-04 — left per-target, same reasoning as Key.tsx."],
  ["scripts/translate-from-studio.mjs", "This script. Translating itself would be exciting, in the bad sense."],
];

// ---------------------------------------------------------------------------
// Filesystem helpers (EOL-safe compare — both repos mix CRLF/LF file-by-file)
// ---------------------------------------------------------------------------

function hasCRLF(buf) {
  return buf.includes(Buffer.from("\r\n"));
}

function toLF(buf) {
  return buf.toString("utf8").replace(/\r\n/g, "\n");
}

/** Same content once line endings are normalised away. */
function contentEquals(bufA, bufB) {
  return toLF(bufA) === toLF(bufB);
}

/**
 * Normalises `srcBuf` to whichever line ending the destination already uses.
 * A brand-new file (nothing at that path in Float yet) has no existing
 * convention to match, so it keeps studio's own.
 */
function normalizeEol(srcBuf, floatAbsPath) {
  const text = toLF(srcBuf);
  const useCRLF = existsSync(floatAbsPath)
    ? hasCRLF(readFileSync(floatAbsPath))
    : hasCRLF(srcBuf);
  return Buffer.from(useCRLF ? text.replace(/\n/g, "\r\n") : text, "utf8");
}

/**
 * What to write for one candidate. A file whose content already matches
 * (ignoring line endings) keeps the destination's EXACT existing bytes,
 * untouched — only a genuine content change gets re-normalized to the
 * destination's line-ending convention. A brand-new file (dmacConfig.ts, on
 * the first run) has no destination bytes to keep, so it's just normalized.
 */
function renderBytes(srcBuf, floatAbsPath) {
  if (existsSync(floatAbsPath)) {
    const curBuf = readFileSync(floatAbsPath);
    if (contentEquals(srcBuf, curBuf)) return curBuf;
  }
  return normalizeEol(srcBuf, floatAbsPath);
}

function isProtected(rel) {
  return PROTECTED.some(([p]) => rel === p || rel.startsWith(p + "/"));
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

/** Manifest entries whose studio source exists in this checkout. */
function collectCandidates(studioRoot) {
  return MANIFEST.filter((e) => existsSync(join(studioRoot, e.studio)));
}

/** Renders every candidate into `outDir` (mirroring float-relative paths), EOL-normalized. */
function render(studioRoot, outDir, candidates) {
  for (const e of candidates) {
    const srcBuf = readFileSync(join(studioRoot, e.studio));
    const destAbs = join(outDir, e.float);
    mkdirSync(dirname(destAbs), { recursive: true });
    const outBuf = renderBytes(srcBuf, join(FLOAT_ROOT, e.float));
    writeFileSync(destAbs, outBuf);
  }
}

/** created / updated / unchanged, by comparing the render against FLOAT_ROOT. */
function classify(candidates, outDir) {
  const created = [];
  const updated = [];
  const unchanged = [];
  for (const e of candidates) {
    const outBuf = readFileSync(join(outDir, e.float));
    const floatAbs = join(FLOAT_ROOT, e.float);
    if (!existsSync(floatAbs)) {
      created.push(e);
    } else if (!readFileSync(floatAbs).equals(outBuf)) {
      updated.push(e);
    } else {
      unchanged.push(e);
    }
  }
  return { created, updated, unchanged };
}

/**
 * Manifest entries whose studio source has vanished but whose float target
 * still exists — a stale leftover from a previous translation.
 */
function findStaleFiles(candidates) {
  const candidateFloatPaths = new Set(candidates.map((e) => e.float));
  const stale = [];
  for (const e of MANIFEST) {
    if (candidateFloatPaths.has(e.float)) continue; // still a live candidate
    if (isProtected(e.float)) continue; // defensive; should never trigger
    if (existsSync(join(FLOAT_ROOT, e.float))) stale.push(e);
  }
  return stale;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function printReport({ created, updated, unchanged, stale }) {
  console.log(`\n== translation report ==`);
  console.log(`   ${created.length} to create`);
  console.log(`   ${updated.length} to update`);
  console.log(`   ${unchanged.length} unchanged`);
  console.log(`   ${stale.length} stale (in Float, gone from studio) — to delete`);
  console.log(`   ${MANIFEST.length} manifest path(s), ${PROTECTED.length} protected path(s) documented`);

  const list = (label, items) => {
    if (!items.length) return;
    console.log(`\n-- ${label} --`);
    for (const e of items) console.log(`   ${e.float}  (from studio ${e.studio})`);
  };
  list("create", created);
  list("update", updated);
  list("delete (stale)", stale);
}

// ---------------------------------------------------------------------------
// Post-translate verification (real runs only)
// ---------------------------------------------------------------------------

function runVerification() {
  const steps = [
    ["npx", ["tsc", "--noEmit"], FLOAT_ROOT, "root: npx tsc --noEmit"],
    ["npx", ["tsc", "--noEmit"], join(FLOAT_ROOT, "web"), "web: npx tsc --noEmit"],
    ["npm", ["run", "build"], join(FLOAT_ROOT, "web"), "web: npm run build"],
    ["npm", ["run", "build"], FLOAT_ROOT, "root: npm run build"],
  ];

  console.log("\n== verification ==");
  const results = [];
  for (const [cmd, cmdArgs, cwd, label] of steps) {
    console.log(`\n-- ${label} --`);
    const res = spawnSync(cmd, cmdArgs, {
      cwd,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    const ok = res.status === 0;
    results.push([label, ok]);
    console.log(`-- ${label}: ${ok ? "OK" : "FAILED"} --`);
  }

  console.log("\n== verification summary ==");
  let failed = false;
  for (const [label, ok] of results) {
    console.log(`   ${ok ? "OK  " : "FAIL"}  ${label}`);
    if (!ok) failed = true;
  }
  return !failed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const checkMode = args.includes("--check");
  const studioArg = args.find((a) => !a.startsWith("--"));
  const studioRoot = resolve(FLOAT_ROOT, studioArg || "../torabo-studio");

  if (!existsSync(join(studioRoot, "package.json"))) {
    console.error(`No studio checkout found at ${studioRoot}`);
    process.exit(1);
  }

  const tmp = mkdtempSync(join(tmpdir(), "translate-from-studio-"));
  try {
    const candidates = collectCandidates(studioRoot);
    render(studioRoot, tmp, candidates);
    const { created, updated, unchanged } = classify(candidates, tmp);
    const stale = findStaleFiles(candidates);

    printReport({ created, updated, unchanged, stale });

    if (checkMode) {
      const dirty = created.length || updated.length || stale.length;
      if (dirty) {
        console.error(
          `\ndrift: ${created.length} to create, ${updated.length} to update, ${stale.length} to delete.`,
        );
        process.exit(1);
      }
      console.log("\nno drift.");
      return;
    }

    for (const e of [...created, ...updated]) {
      const destAbs = join(FLOAT_ROOT, e.float);
      mkdirSync(dirname(destAbs), { recursive: true });
      copyFileSync(join(tmp, e.float), destAbs);
    }
    for (const e of stale) {
      rmSync(join(FLOAT_ROOT, e.float));
    }
    console.log(
      `\napplied: ${created.length} created, ${updated.length} updated, ${stale.length} deleted.`,
    );

    const ok = runVerification();
    if (!ok) {
      console.error("\nverification failed — see above.");
      process.exit(1);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
