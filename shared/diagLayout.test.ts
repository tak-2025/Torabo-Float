// Tests for the diag panel's placement rules — above all the ordering one:
// every rotation device (dial or encoder) arrives as a kind=ENC diag record,
// so which knob a row describes is decided ENTIRELY by its position among the
// other kind=ENC rows. Getting that wrong is not a cosmetic bug: it puts one
// knob's live counters under the other knob's name, which is exactly what the
// pre-2026-09-07 kind search did on a two-knob board (a left dial plus a
// right extension encoder, both resolving to the dial).
//
// The single-device cases are here for the opposite reason: the numbering
// rule had to arrive without changing a single existing board's panel, so
// each of the three one-knob shapes is pinned to the label it has always had.
//
// Pure functions, no component tree — same discipline as the module itself.
import { describe, expect, it } from "vitest";
import { CapsSide, ModuleKind, ModuleSlots } from "./caps/toraboCaps";
import { DiagRecord, Status, decodeMeta } from "./diag";
import {
  DIAG_GRID_CONNS,
  DIAG_GRID_SIDES,
  DeclaredModules,
  declaredRowLabel,
  diagGrid,
  diagRowViews,
  makeLabel,
  rotationSlots,
  shouldHidePeripheralRow,
} from "./diagLayout";

// --- record builders --------------------------------------------------------
// The wire's own field layout (diag.ts's header): meta packs side/conn/kind,
// `detail` is a positional overload that means cw|ccw<<8|btn<<16 on a kind=ENC
// row and a bare reg-slot integer on a split-receiver row.

const META = (side: number, conn: number, kind: number) =>
  (side & 0b11) | ((conn & 0b11) << 2) | ((kind & 0b11) << 4);

function rec(fields: Partial<DiagRecord> & { deviceId: number }): DiagRecord {
  const meta = fields.meta ?? 0;
  return {
    protoVer: 1,
    evtType: 4,
    meta,
    metaFields: decodeMeta(meta),
    status: 0,
    errCode: 0,
    eventCount: 0,
    lastTickMs: 0,
    detail: 0,
    ...fields,
  };
}

/** One kind=ENC row — a rotation sensor. Local by construction (the pseudo
 * devices live in the central's diag_devs[] whichever half the sensor is on). */
function rotationRec(
  deviceId: number,
  counters: { cw: number; ccw: number; btn: number },
  present = true,
): DiagRecord {
  return rec({
    deviceId,
    meta: META(0, 0, 3 /* Kind.ENCODER */),
    status: present ? Status.PRESENT | Status.INIT_OK | Status.EVENT_SEEN : 0,
    detail: counters.cw | (counters.ccw << 8) | (counters.btn << 16),
  });
}

/** A local pointing device on the connected half (a real driver row). */
function localPointingRec(deviceId: number, side: number, conn: number, kind: number) {
  return rec({
    deviceId,
    meta: META(side, conn, kind),
    status: Status.PRESENT | Status.INIT_OK | Status.EVENT_SEEN,
  });
}

/** A split-receiver row: meta is always 0, `detail` byte0 is the reg slot. */
function peripheralRec(deviceId: number, slot: number) {
  return rec({
    deviceId,
    meta: 0,
    status: Status.PERIPHERAL | Status.EVENT_SEEN,
    detail: slot,
  });
}

// --- declarations -----------------------------------------------------------

function slots(partial: Partial<ModuleSlots>): ModuleSlots {
  return {
    leftStd: ModuleKind.None,
    leftExt: ModuleKind.None,
    rightStd: ModuleKind.None,
    rightExt: ModuleKind.None,
    ...partial,
  };
}

const declaring = (
  partial: Partial<ModuleSlots>,
  centralSide: CapsSide = CapsSide.Right,
): DeclaredModules => ({ moduleSlots: slots(partial), centralSide });

const labels = (views: ReturnType<typeof diagRowViews>) => views.map((v) => v.label);

// ---------------------------------------------------------------------------

describe("rotationSlots", () => {
  it("orders the peripheral half's connectors first, then the central's", () => {
    // PLAN-dial-tab.md §6.2: a peripheral numbers its own sensors from 0 and
    // ZMK relays those numbers verbatim, so the peer's devices lead the list.
    expect(
      rotationSlots(
        slots({
          leftStd: ModuleKind.Dial,
          leftExt: ModuleKind.Encoder,
          rightStd: ModuleKind.Encoder,
          rightExt: ModuleKind.Encoder,
        }),
        CapsSide.Right,
      ),
    ).toEqual([
      { side: CapsSide.Left, conn: "std", kind: ModuleKind.Dial },
      { side: CapsSide.Left, conn: "ext", kind: ModuleKind.Encoder },
      { side: CapsSide.Right, conn: "std", kind: ModuleKind.Encoder },
      { side: CapsSide.Right, conn: "ext", kind: ModuleKind.Encoder },
    ]);
  });

  it("follows the central side rather than left/right", () => {
    expect(
      rotationSlots(
        slots({ leftStd: ModuleKind.Encoder, rightExt: ModuleKind.Dial }),
        CapsSide.Left,
      ),
    ).toEqual([
      { side: CapsSide.Right, conn: "ext", kind: ModuleKind.Dial },
      { side: CapsSide.Left, conn: "std", kind: ModuleKind.Encoder },
    ]);
  });

  it("skips pointing devices and empty connectors", () => {
    expect(
      rotationSlots(
        slots({
          leftStd: ModuleKind.Pad,
          leftExt: ModuleKind.Ball,
          rightStd: ModuleKind.FourWaySwitch,
          rightExt: ModuleKind.Undeclared,
        }),
        CapsSide.Right,
      ),
    ).toEqual([]);
  });

  it("is empty when the declaration cannot place anything", () => {
    // No MODULES row, or a header that never named the central half — there
    // is no peripheral-vs-central ordering without it.
    expect(rotationSlots(null, CapsSide.Right)).toEqual([]);
    expect(
      rotationSlots(slots({ leftStd: ModuleKind.Dial }), CapsSide.Unknown),
    ).toEqual([]);
    expect(rotationSlots(slots({ leftStd: ModuleKind.Dial }), null)).toEqual([]);
  });
});

describe("KIND_WORD", () => {
  it("names a declared 4-way switch slot", () => {
    // FourWaySwitch (caps.h TORABO_CAPS_SLOT_SWITCH4) is a kscan matrix
    // device with no diag-wire representation at all, so no diag row ever
    // resolves to it in practice — unlike Dial/Encoder/Pad/Ball, it has no
    // diagRowViews()-level test. This pins the label makeLabel() renders for
    // it directly, the same word KIND_WORD carries for every other kind.
    expect(makeLabel(CapsSide.Left, "std", ModuleKind.FourWaySwitch, false)?.text).toBe(
      "左標準: 4方向スイッチ",
    );
  });
});

describe("single rotation device (unchanged by the sensor-index rule)", () => {
  it("names a lone peripheral dial after its declared connector", () => {
    const declared = declaring({ leftStd: ModuleKind.Dial });
    const views = diagRowViews(declared, [rotationRec(0, { cw: 3, ccw: 1, btn: 0 })]);
    expect(labels(views)).toEqual(["左標準: 高分解能ダイヤル"]);
  });

  it("names a lone central-local encoder", () => {
    const declared = declaring({ rightStd: ModuleKind.Encoder });
    const views = diagRowViews(declared, [rotationRec(0, { cw: 2, ccw: 2, btn: 1 })]);
    expect(labels(views)).toEqual(["右標準: エンコーダ"]);
  });

  it("names a lone peripheral encoder", () => {
    const declared = declaring({ leftStd: ModuleKind.Encoder });
    const views = diagRowViews(declared, [rotationRec(0, { cw: 0, ccw: 0, btn: 0 })]);
    expect(labels(views)).toEqual(["左標準: エンコーダ"]);
  });

  it("hides the peripheral reg-2 row that duplicates the knob's identity", () => {
    const declared = declaring({ leftStd: ModuleKind.Dial });
    const views = diagRowViews(declared, [
      rotationRec(0, { cw: 0, ccw: 0, btn: 0 }),
      peripheralRec(1, 2),
    ]);
    expect(labels(views)).toEqual(["左標準: 高分解能ダイヤル"]);
    expect(shouldHidePeripheralRow(declared, peripheralRec(1, 2))).toBe(true);
  });

  it("keeps the reg-2 row when the peripheral declares no knob at all", () => {
    const declared = declaring({ leftStd: ModuleKind.Pad, rightStd: ModuleKind.Encoder });
    expect(shouldHidePeripheralRow(declared, peripheralRec(1, 2))).toBe(false);
  });

  it("reads a declared dial with no PRESENT bit as 検知不可, with no counters", () => {
    // enc_diag_get() is a __weak stub for a dial — the all-zero row means the
    // firmware never looked, not that nothing is fitted.
    const declared = declaring({ leftStd: ModuleKind.Dial });
    const [view] = diagRowViews(declared, [
      rotationRec(0, { cw: 0, ccw: 0, btn: 0 }, false),
    ]);
    expect(view.label).toBe("左標準: 高分解能ダイヤル");
    expect(view.undetectable).toBe(true);
  });

  it("hides the pseudo-device row on a board that declares no knob anywhere", () => {
    const declared = declaring({ rightStd: ModuleKind.Ball });
    expect(diagRowViews(declared, [rotationRec(0, { cw: 0, ccw: 0, btn: 0 }, false)])).toEqual(
      [],
    );
  });

  it("falls back to diag.ts's plain label with no declaration at all", () => {
    const views = diagRowViews(
      { moduleSlots: null, centralSide: null },
      [rotationRec(0, { cw: 1, ccw: 0, btn: 0 })],
    );
    expect(labels(views)).toEqual(["エンコーダ"]);
  });
});

describe("two rotation devices (left standard dial + right extension encoder)", () => {
  // The reported hardware: sensor 0 = the peripheral's standard dial, sensor
  // 1 = the central's extension EC11, central = right.
  const declared = declaring({
    leftStd: ModuleKind.Dial,
    leftExt: ModuleKind.Pad,
    rightStd: ModuleKind.Ball,
    rightExt: ModuleKind.Encoder,
  });

  const records = [
    localPointingRec(0, 2 /* right */, 1 /* std FFC */, 2 /* Kind.BALL */),
    rotationRec(1, { cw: 7, ccw: 3, btn: 1 }), // sensor 0 — the dial
    rotationRec(2, { cw: 40, ccw: 41, btn: 2 }), // sensor 1 — the encoder
    peripheralRec(3, 0), // the peripheral's extension pad
    peripheralRec(4, 2), // the dial's push button — redundant
  ];

  it("shows four rows, each named after its own connector", () => {
    expect(labels(diagRowViews(declared, records))).toEqual([
      "右標準: ボール",
      "左標準: 高分解能ダイヤル",
      "右拡張: エンコーダ",
      "左拡張: パッド",
    ]);
  });

  it("keeps each knob's counters under its own name", () => {
    const views = diagRowViews(declared, records);
    const counters = (label: string) => views.find((v) => v.label === label)?.rec?.detail;
    expect(counters("左標準: 高分解能ダイヤル")).toBe(7 | (3 << 8) | (1 << 16));
    expect(counters("右拡張: エンコーダ")).toBe(40 | (41 << 8) | (2 << 16));
  });

  it("hides the standard button row but not the extension pad's reg-0 row", () => {
    expect(shouldHidePeripheralRow(declared, peripheralRec(4, 2))).toBe(true);
    expect(shouldHidePeripheralRow(declared, peripheralRec(3, 0))).toBe(false);
  });

  it("takes the sensor index from device_id order, not arrival order", () => {
    const shuffled = [records[2], records[1]];
    expect(labels(diagRowViews(declared, shuffled))).toEqual([
      "右拡張: エンコーダ",
      "左標準: 高分解能ダイヤル",
    ]);
  });

  it("synthesizes the missing knob on firmware that sends only one ENC row", () => {
    // Old firmware: one pseudo-device however many knobs are declared. The
    // dial keeps its measurements; the encoder gets a name and nothing else.
    const views = diagRowViews(declared, [
      records[0],
      rotationRec(1, { cw: 7, ccw: 3, btn: 1 }),
      records[3],
      records[4],
    ]);
    expect(labels(views)).toEqual([
      "右標準: ボール",
      "左標準: 高分解能ダイヤル",
      "右拡張: エンコーダ",
      "左拡張: パッド",
    ]);

    const dial = views[1];
    expect(dial.undetectable).toBe(false);
    expect(dial.rec?.detail).toBe(7 | (3 << 8) | (1 << 16));

    const encoder = views[2];
    expect(encoder.rec).toBeNull(); // no counters, no count, no last-seen
    expect(encoder.undetectable).toBe(true); // 検知不可
  });

  it("names an undeclared extra knob by its sensor index", () => {
    const views = diagRowViews(declaring({ leftStd: ModuleKind.Dial }), [
      rotationRec(1, { cw: 1, ccw: 0, btn: 0 }),
      rotationRec(2, { cw: 2, ccw: 0, btn: 0 }),
    ]);
    expect(labels(views)).toEqual(["左標準: 高分解能ダイヤル", "回転デバイス #1"]);
  });

  it("never invents rows before the first record arrives", () => {
    expect(diagRowViews(declared, [])).toEqual([]);
  });
});

describe("peripheral rotation buttons (reg 2 = standard, reg 3 = extension)", () => {
  const text = (declared: DeclaredModules, slot: number) =>
    declaredRowLabel(declared, peripheralRec(1, slot))?.text ?? null;

  it("names each button row after its own connector", () => {
    const declared = declaring({
      leftStd: ModuleKind.Dial,
      leftExt: ModuleKind.Encoder,
    });
    expect(text(declared, 2)).toBe("左標準: 高分解能ダイヤル");
    expect(text(declared, 3)).toBe("左拡張: エンコーダ");
  });

  it("hides both button rows when both connectors declare a knob", () => {
    const declared = declaring({
      leftStd: ModuleKind.Dial,
      leftExt: ModuleKind.Encoder,
    });
    expect(shouldHidePeripheralRow(declared, peripheralRec(1, 2))).toBe(true);
    expect(shouldHidePeripheralRow(declared, peripheralRec(2, 3))).toBe(true);
  });

  it("hides only the connector that actually declares a knob", () => {
    const declared = declaring({ leftStd: ModuleKind.Pad, leftExt: ModuleKind.Encoder });
    expect(shouldHidePeripheralRow(declared, peripheralRec(1, 3))).toBe(true);
    expect(shouldHidePeripheralRow(declared, peripheralRec(2, 2))).toBe(false);
  });

  it("still names a pre-2026-09-07 extension button that rode reg 2", () => {
    // Before the extension got its own reg, a lone extension knob's button
    // arrived on reg 2 like a standard one — reg 2 falls back to the
    // extension connector when the standard one declares no knob.
    expect(text(declaring({ leftExt: ModuleKind.Encoder }), 2)).toBe("左拡張: エンコーダ");
  });

  it("leaves a reg slot the convention has no rule for unnamed", () => {
    expect(text(declaring({ leftStd: ModuleKind.Dial }), 4)).toBeNull();
  });
});

describe("diagGrid — 2 halves x 2 connectors", () => {
  // The reported hardware, as the panel lays it out: 右拡張 = エンコーダ,
  // 右標準 = トラックボール, 左拡張 = トラックパッド, 左標準 =
  // 高分解能ダイヤル. Same declaration and same records as the two-knob
  // describe above; what is under test here is only where each row lands.
  const declared = declaring({
    leftStd: ModuleKind.Dial,
    leftExt: ModuleKind.Pad,
    rightStd: ModuleKind.Ball,
    rightExt: ModuleKind.Encoder,
  });

  const records = [
    localPointingRec(0, 2 /* right */, 1 /* std FFC */, 2 /* Kind.BALL */),
    rotationRec(1, { cw: 7, ccw: 3, btn: 1 }), // sensor 0 — the left dial
    rotationRec(2, { cw: 40, ccw: 41, btn: 2 }), // sensor 1 — the right encoder
    peripheralRec(3, 0), // the peripheral's extension pad
    peripheralRec(4, 2), // the dial's push button — redundant, hidden
  ];

  /** The whole grid as `連結名 -> ラベル[]`, cells in their emitted order. */
  const cellMap = (views: ReturnType<typeof diagRowViews>) =>
    diagGrid(views).cells.map(
      (c) => [c.title, c.rows.map((r) => r.label)] as [string, string[]],
    );

  it("puts each of the four devices in its own cell", () => {
    expect(cellMap(diagRowViews(declared, records))).toEqual([
      ["左拡張", ["左拡張: パッド"]],
      ["左標準", ["左標準: 高分解能ダイヤル"]],
      ["右拡張", ["右拡張: エンコーダ"]],
      ["右標準", ["右標準: ボール"]],
    ]);
  });

  it("emits the halves in DIAG_GRID_SIDES order, connectors in DIAG_GRID_CONNS order", () => {
    // The column order is the one constant to flip; the row order puts the
    // extension connector above the standard one. Pinned as data rather than
    // only through the labels above so a flip is a deliberate edit here too.
    expect(DIAG_GRID_SIDES).toEqual([CapsSide.Left, CapsSide.Right]);
    expect(DIAG_GRID_CONNS).toEqual(["ext", "std"]);
    expect(diagGrid(diagRowViews(declared, records)).cells.map((c) => c.place)).toEqual([
      { side: CapsSide.Left, conn: "ext" },
      { side: CapsSide.Left, conn: "std" },
      { side: CapsSide.Right, conn: "ext" },
      { side: CapsSide.Right, conn: "std" },
    ]);
  });

  it("classifies without touching the rendered text", () => {
    // The placement is data on the view, not the label string parsed back
    // apart: a row keeps its own name, chip source and counters.
    const views = diagRowViews(declared, records);
    const encoder = views.find((v) => v.label === "右拡張: エンコーダ");
    expect(encoder?.place).toEqual({ side: CapsSide.Right, conn: "ext" });
    expect(encoder?.rec?.detail).toBe(40 | (41 << 8) | (2 << 16));
  });

  it("leaves その他 empty when every row is placed", () => {
    expect(diagGrid(diagRowViews(declared, records)).other).toEqual([]);
  });

  it("keeps a synthesized 検知不可 row in its own cell", () => {
    // Old firmware sends one kind=ENC row for two declared knobs: the missing
    // one is synthesized, and it belongs in the cell it was declared at — not
    // in その他, which is for rows nothing could place.
    const grid = diagGrid(
      diagRowViews(declared, [records[0], rotationRec(1, { cw: 7, ccw: 3, btn: 1 }), records[3]]),
    );
    const encCell = grid.cells.find((c) => c.title === "右拡張");
    expect(encCell?.rows.map((r) => r.label)).toEqual(["右拡張: エンコーダ"]);
    expect(encCell?.rows[0].rec).toBeNull();
    expect(encCell?.rows[0].undetectable).toBe(true);
    expect(grid.other).toEqual([]);
  });
});

describe("diagGrid — empty cells and その他", () => {
  const cellRows = (grid: ReturnType<typeof diagGrid>, title: string) =>
    grid.cells.find((c) => c.title === title)?.rows.map((r) => r.label);

  it("still emits all four cells when only one connector reported anything", () => {
    // An empty cell is an answer ("nothing on this connector"), so it is kept
    // and rendered as its name over 「なし」 rather than dropped.
    const grid = diagGrid(
      diagRowViews(declaring({ rightStd: ModuleKind.Ball }), [
        localPointingRec(0, 2, 1, 2 /* Kind.BALL */),
      ]),
    );
    expect(grid.cells).toHaveLength(4);
    expect(grid.cells.map((c) => c.title)).toEqual(["左拡張", "左標準", "右拡張", "右標準"]);
    expect(cellRows(grid, "右標準")).toEqual(["右標準: ボール"]);
    expect(cellRows(grid, "右拡張")).toEqual([]);
    expect(cellRows(grid, "左拡張")).toEqual([]);
    expect(cellRows(grid, "左標準")).toEqual([]);
    expect(grid.other).toEqual([]);
  });

  it("sends an unplaceable row to その他 with every cell left empty", () => {
    // No descriptor at all (old firmware / a failed caps read): the label
    // falls back to diag.ts's plain kind word and nothing places the row.
    const views = diagRowViews({ moduleSlots: null, centralSide: null }, [
      rotationRec(0, { cw: 1, ccw: 0, btn: 0 }),
    ]);
    expect(views[0].place).toBeNull();

    const grid = diagGrid(views);
    expect(grid.cells.every((c) => c.rows.length === 0)).toBe(true);
    expect(grid.other.map((r) => r.label)).toEqual(["エンコーダ"]);
  });

  it("sends a knob past the last declared slot to その他", () => {
    // A declared slot names sensor 0; sensor 1 is a knob the descriptor does
    // not account for, so it is named by index and has no cell to sit in.
    const grid = diagGrid(
      diagRowViews(declaring({ leftStd: ModuleKind.Dial }), [
        rotationRec(1, { cw: 1, ccw: 0, btn: 0 }),
        rotationRec(2, { cw: 2, ccw: 0, btn: 0 }),
      ]),
    );
    expect(cellRows(grid, "左標準")).toEqual(["左標準: 高分解能ダイヤル"]);
    expect(grid.other.map((r) => r.label)).toEqual(["回転デバイス #1"]);
  });

  it("sends a peripheral row on an unknown reg slot to その他", () => {
    // reg 4 has no rule in the builder convention, so the row keeps diag.ts's
    // generic slot label and stays out of the grid rather than being guessed
    // into a cell.
    const grid = diagGrid(
      diagRowViews(declaring({ leftStd: ModuleKind.Dial, rightStd: ModuleKind.Ball }), [
        rotationRec(0, { cw: 1, ccw: 0, btn: 0 }),
        peripheralRec(5, 4),
      ]),
    );
    expect(cellRows(grid, "左標準")).toEqual(["左標準: 高分解能ダイヤル"]);
    expect(grid.other).toHaveLength(1);
    expect(grid.other[0].place).toBeNull();
  });

  it("loses nothing: every view is in exactly one cell or in その他", () => {
    const views = diagRowViews(
      declaring({ leftStd: ModuleKind.Dial, rightStd: ModuleKind.Ball }),
      [
        localPointingRec(0, 2, 1, 2 /* Kind.BALL */),
        rotationRec(1, { cw: 1, ccw: 0, btn: 0 }),
        rotationRec(2, { cw: 2, ccw: 0, btn: 0 }),
        peripheralRec(5, 4),
      ],
    );
    const grid = diagGrid(views);
    const keys = [...grid.cells.flatMap((c) => c.rows), ...grid.other].map((r) => r.key);
    expect(keys.slice().sort()).toEqual(views.map((v) => v.key).sort());
    expect(new Set(keys).size).toBe(views.length);
  });
});
