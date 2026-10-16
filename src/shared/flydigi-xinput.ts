/**
 * Flydigi Direwolf 4 ("fp4") config protocol.
 *
 * Source: Space Station's own service code (Flydigi.ControllerSDK), proven on a
 * Direwolf 4 by readback (docs/flydigi.md). Fixture: fixtures/flydigi/fp4-cfg1.bin
 * is a real read.
 *
 * Commands are written here in Space Station's XInput form (`A5 <cmd> …`, replies
 * `… A5 <cmd> …` inside Xbox 360 reports) because that is how they were first
 * captured; fxToDInput / fxFromDInput translate to the plain-HID form Stick Labs
 * actually sends (report 0x05, replies `04 FF F0 …`). The XInput form is no longer
 * a transport, only the canonical in-memory shape.
 *
 * The config is one blob split into 10-byte packs (V3.1: 84 packs = 840
 * bytes). A write sends only changed packs: start, then one command per pack.
 */

export const FX_ENDPOINT_TAG = 0xa5
export const FX_FRAME_LEN = 15
export const FX_REPORT_LEN = 32
export const FX_PACK_SIZE = 10
export const FX_BLOB_LEN = 840

export const FX_CMD_READ_CFG_ID = 0x20
export const FX_CMD_READ_CFG = 0x21
export const FX_CMD_READ_CFG_ACK = 0x22
export const FX_CMD_WRITE_START = 0x23
export const FX_CMD_WRITE_PACK = 0x24
export const FX_CMD_SAVE = 0x50
export const FX_SUB_SAVE = 0x03
export const FX_SUB_APPLY = 0x05
export const FX_MARK = 0xa0

/** Blob offsets (V3.0 layout). Unused bytes are 0xFF. */
export const FX_OFF = {
  protoVersion: 0, // u16 LE (0x0301 on this pad)
  keys: 13, // 32 keys x 3 bytes, to 109
  joystick: 109, // 2 x 7 bytes, to 123
  triggers: 123, // 14 bytes, to 137
  motion: 137, // 8 bytes, to 145
  vibration: 145, // 9 bytes, to 154
  dataVersion: 225, // u16 LE
  curves: 790 // V3.1 extra: 2 x 12 bytes (type, 9 points, circularity, edge), to 814
} as const

function frame(cmd: number, ...args: number[]): Uint8Array {
  const f = new Uint8Array(FX_FRAME_LEN)
  f[0] = FX_ENDPOINT_TAG
  f[1] = cmd
  args.forEach((a, i) => (f[2 + i] = a & 0xff))
  return f
}

export const fxReadConfigId = (): Uint8Array => frame(FX_CMD_READ_CFG_ID)
export const fxReadConfig = (cfgId: number): Uint8Array => frame(FX_CMD_READ_CFG, cfgId)
export const fxWriteStart = (startPack: number, packCount: number, cfgId: number): Uint8Array =>
  frame(FX_CMD_WRITE_START, startPack, packCount, FX_MARK, cfgId)

export function fxWritePack(data: Uint8Array, packNum: number): Uint8Array {
  if (data.length !== FX_PACK_SIZE) throw new Error(`fx: a pack is ${FX_PACK_SIZE} bytes, got ${data.length}`)
  const f = frame(FX_CMD_WRITE_PACK)
  f.set(data, 2)
  f[12] = FX_MARK
  f[13] = packNum
  return f
}

/** Persist the current config; `dataVersion` is the blob's u16 at 225. */
export const fxSave = (dataVersion: number): Uint8Array =>
  frame(FX_CMD_SAVE, FX_SUB_SAVE, dataVersion & 0xff, (dataVersion >> 8) & 0xff)

/** Make config slot `cfgId` (0-based) the one the pad runs: 0x50 sub 05, as Space Station's ApplyOnboardConfig. */
export const fxApplyConfig = (cfgId: number): Uint8Array => frame(FX_CMD_SAVE, FX_SUB_APPLY, cfgId)

export interface FxAck {
  cmd: number
  data: Uint8Array
}

/** Parse an Xbox 360 input report as a config reply, or null for plain input. */
export function fxParseAck(report: Uint8Array): FxAck | null {
  if (report.length < 16 || report[14] !== FX_ENDPOINT_TAG) return null
  return { cmd: report[15], data: report.subarray(16) }
}

export const fxCfgIdFromAck = (ack: FxAck): number => ack.data[0]
/** Slot count from a 0x20 reply (`A5 20 <id> A0 <count>`). */
export const fxCfgCountFromAck = (ack: FxAck): number => ack.data[2]
export const fxSaveAcked = (ack: FxAck): boolean => ack.cmd === FX_CMD_SAVE && ack.data[0] === FX_SUB_SAVE && ack.data[1] === 1

/** Pack count a read-config reply announces (first pack, index 0). */
export function fxExpectedPacks(firstAck: FxAck): number {
  const d = firstAck.data
  if (d[2] === 3) {
    if (d[1] === 0) return 79
    if (d[1] === 1) return 84
  }
  return d[3]
}

/** Assemble the blob from 0x22 replies (duplicates ignored); null if any pack is missing. */
export function fxAssembleBlob(acks: FxAck[]): Uint8Array | null {
  const packs = new Map<number, Uint8Array>()
  let count = 0
  for (const a of acks) {
    if (a.cmd !== FX_CMD_READ_CFG_ACK) continue
    const idx = a.data[0]
    if (idx === 0) count = fxExpectedPacks(a)
    if (!packs.has(idx)) packs.set(idx, a.data.slice(1, 1 + FX_PACK_SIZE))
  }
  if (count === 0 || packs.size < count) return null
  const out = new Uint8Array(count * FX_PACK_SIZE)
  for (let i = 0; i < count; i++) {
    const p = packs.get(i)
    if (!p) return null
    out.set(p, i * FX_PACK_SIZE)
  }
  return out
}

export interface FxWriteRun {
  startPack: number
  packs: Uint8Array[]
}

/** Runs of consecutive packs that differ between two blobs of equal length. */
export function fxDiffPacks(oldBlob: Uint8Array, newBlob: Uint8Array): FxWriteRun[] {
  if (oldBlob.length !== newBlob.length) throw new Error('fx: blob length changed; refusing to diff')
  const runs: FxWriteRun[] = []
  const n = Math.floor(newBlob.length / FX_PACK_SIZE)
  let cur: FxWriteRun | null = null
  for (let i = 0; i < n; i++) {
    const a = oldBlob.subarray(i * FX_PACK_SIZE, (i + 1) * FX_PACK_SIZE)
    const b = newBlob.subarray(i * FX_PACK_SIZE, (i + 1) * FX_PACK_SIZE)
    if (a.every((v, k) => v === b[k])) {
      cur = null
    } else {
      if (!cur) {
        cur = { startPack: i, packs: [] }
        runs.push(cur)
      }
      cur.packs.push(b.slice())
    }
  }
  return runs
}

/** Frames for one run: start, then packs numbered 0..n-1 within the run. */
export function fxRunFrames(run: FxWriteRun, cfgId: number): Uint8Array[] {
  return [fxWriteStart(run.startPack, run.packs.length, cfgId), ...run.packs.map((p, i) => fxWritePack(p, i))]
}

// --- polling rate (a device setting, only reachable in XInput mode through the filter driver) ---

/** Report-rate codes Space Station uses and the rate each means (Direwolf 4: no 8K gears). */
export const FX_REPORT_RATES: ReadonlyArray<{ code: number; hz: number }> = [
  { code: 1, hz: 1000 },
  { code: 2, hz: 500 },
  { code: 4, hz: 250 },
  { code: 8, hz: 125 }
]
export const fxHzFromReportRate = (code: number | null): number | null => FX_REPORT_RATES.find((r) => r.code === code)?.hz ?? null

// --- DInput mode (04B4:2412, vendor interface 2): same commands over plain HID ---
//
// Space Station's DInputProtocol sends report 0x05 with different command bytes
// and answers in 32-byte reports led by report id 0x04 (`04 FF F0 ...`). The
// session logic is shared, so these two helpers translate at the transport edge:
// XInput-style frames out, XInput-style acks in.

export const FXD_REPORT_ID = 0x05

/** Translate an XInput-style command frame (A5 <cmd> …) into the DInput HID report. */
export function fxToDInput(frame: Uint8Array): Uint8Array {
  const f = frame.slice()
  f[0] = FXD_REPORT_ID
  switch (frame[1]) {
    case FX_CMD_READ_CFG_ID:
      f[1] = 0xeb
      f[2] = FX_MARK
      return f
    case FX_CMD_READ_CFG:
      f[1] = 0xeb
      return f
    case FX_CMD_WRITE_START:
      f[1] = 0xef
      return f
    case FX_CMD_WRITE_PACK:
      f[1] = 0x22
      return f
    case FX_CMD_SAVE:
      return f
    default:
      throw new Error(`fx: no DInput form for command 0x${frame[1].toString(16)}`)
  }
}

/**
 * Switch the pad from DInput back to XInput mode (Space Station's legacy
 * SwitchToXInput, command 0xED). Already a DInput-form report; not run through
 * fxToDInput. The pad re-enumerates as 045E:028E afterwards.
 */
export const fxDInputSwitchToXInput = (): Uint8Array => {
  const f = new Uint8Array(FX_FRAME_LEN)
  f[0] = FXD_REPORT_ID
  f[1] = 0xed
  return f
}

/**
 * Normalise a DInput reply report (report id first) into XInput-style acks.
 * Plain input reports (`04 FE 66 …`) and get-info replies yield none.
 */
export function fxFromDInput(r: Uint8Array): FxAck[] {
  if (r.length < 16 || r[1] !== 0xff || r[2] !== 0xf0) return []
  if (r[15] === 0xeb) return [{ cmd: FX_CMD_READ_CFG_ACK, data: Uint8Array.of(r[3], ...r.subarray(5, 15)) }]
  if (r[15] === 0xea) return [{ cmd: FX_CMD_WRITE_START, data: new Uint8Array(0) }, { cmd: FX_CMD_WRITE_PACK, data: new Uint8Array(0) }]
  if (r[3] === 0xaa && r[4] === 0xac) return [{ cmd: FX_CMD_READ_CFG_ID, data: Uint8Array.of(r[5], r[6], r[7]) }]
  if (r[3] === FX_CMD_SAVE) return [{ cmd: FX_CMD_SAVE, data: Uint8Array.of(r[4], 1) }]
  return []
}

// --- decode / encode (only fields whose meaning is proven) ---

export interface FxVibrationMotor {
  enabled: boolean
  min: number
  max: number
  scale: number
}
export interface FxVibration {
  enabled: boolean
  left: FxVibrationMotor
  right: FxVibrationMotor
}

const u16 = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8)

export const fxDataVersion = (blob: Uint8Array): number => u16(blob, FX_OFF.dataVersion)
export const fxProtoVersion = (blob: Uint8Array): number => u16(blob, FX_OFF.protoVersion)

export function fxDecodeVibration(blob: Uint8Array): FxVibration {
  const v = blob.subarray(FX_OFF.vibration, FX_OFF.vibration + 9)
  const motor = (o: number): FxVibrationMotor => ({
    enabled: v[o] === 0,
    min: Math.min(v[o + 1], v[o + 2]),
    max: Math.max(v[o + 1], v[o + 2]),
    scale: v[o + 3]
  })
  return { enabled: v[0] === 0, left: motor(1), right: motor(5) }
}

/** Returns a copy of `blob` with the vibration record replaced. */
export function fxEncodeVibration(blob: Uint8Array, vib: FxVibration): Uint8Array {
  const out = blob.slice()
  const o = FX_OFF.vibration
  out[o] = vib.enabled ? 0 : 0xff
  const put = (at: number, m: FxVibrationMotor): void => {
    out[at] = m.enabled ? 0 : 0xff
    out[at + 1] = m.min
    out[at + 2] = m.max
    out[at + 3] = m.scale
  }
  put(o + 1, vib.left)
  put(o + 5, vib.right)
  return out
}

/** Raw per-stick record (7 bytes at 109 / 116); the scaled fields are not decoded. */
export interface FxStickRaw {
  type: number
  center: number
  p1x: number
  p1y: number
  p2x: number
  p2y: number
  end: number
}

export function fxDecodeSticks(blob: Uint8Array): { left: FxStickRaw; right: FxStickRaw } {
  const rec = (o: number): FxStickRaw => ({
    type: blob[o],
    center: blob[o + 1],
    p1x: blob[o + 2],
    p1y: blob[o + 3],
    p2x: blob[o + 4],
    p2y: blob[o + 5],
    end: blob[o + 6]
  })
  return { left: rec(FX_OFF.joystick), right: rec(FX_OFF.joystick + 7) }
}

/** Set one stick's centre (deadzone) byte; the only stick field proven so far. */
export function fxSetStickCenter(blob: Uint8Array, side: 0 | 1, center: number): Uint8Array {
  const out = blob.slice()
  out[FX_OFF.joystick + side * 7 + 1] = center & 0xff
  return out
}

/** Sensitivity type byte: 0 = Default ramp, 3 = Custom (the 9 points apply). 1/2 are Quick/Slow presets, not decoded. */
export const FX_CURVE_DEFAULT = 0
export const FX_CURVE_CUSTOM = 3
/** The stock ramp Space Station leaves on an untouched stick (right stick of the real read). */
export const FX_CURVE_DEFAULT_POINTS: readonly number[] = [50, 63, 75, 88, 100, 113, 125, 138, 150]
export const FX_CURVE_POINTS = 9

export interface FxCurve {
  type: number
  /** Nine output samples across the input range (bytes; the stock ramp runs 50..150). */
  points: number[]
  /** 1 = Circular (proven on the left stick); 0 = Rectangle. */
  circularity: number
  /** Raw edge byte, preserved; not decoded. */
  edge: number
}

/**
 * Curve points Space Station writes for a stick's Center (`c`) and Edge (`e`) sliders, each
 * -100..100 and stored as signed bytes (centre in the main stick record, edge in the curve record at
 * +11; edge -30 is 0xe2). Space Station computes the nine points itself: a straight line in output
 * percent over input percent, extended past its ends and clamped to raw 0..150 (raw 50 = 0%, 150 = 100%; the
 * low end is written as raw 0, i.e. -50%, not clamped at 50).
 *
 *   start: c >= 0 -> crosses 0% at input c% (the deadzone);  c < 0 -> starts at |c|% (the offset)
 *   end:   e <= 0 -> ends at 100% + e% at full travel;       e > 0 -> reaches 100% at input 100% - e%
 *
 * Fitted to Space Station's writes (its service log, tests/flydigixinput.ts): c in -100..100 with e = 0,
 * and c/e = 0/-30, -13/-30, -40/-30, 50/-30, 50/30. Every point is within 1 of its output (it rounds a
 * little differently in places).
 */
export function fxDeadzonePoints(c: number, e = 0): number[] {
  const cc = Math.max(-100, Math.min(100, c))
  const ee = Math.max(-100, Math.min(100, e))
  if (cc >= 100) return Array(FX_CURVE_POINTS).fill(50) // zero-width ramp: flat at 0%
  const x0 = cc >= 0 ? cc / 100 : 0
  const y0 = cc >= 0 ? 0 : -cc / 100
  const x1 = ee > 0 ? 1 - ee / 100 : 1
  const y1 = ee > 0 ? 1 : 1 + ee / 100
  if (x1 <= x0) return Array(FX_CURVE_POINTS).fill(fxCurvePercentToRaw(y1 * 100))
  return Array.from({ length: FX_CURVE_POINTS }, (_, i) => {
    const x = i / (FX_CURVE_POINTS - 1)
    return Math.min(150, fxCurvePercentToRaw((y0 + ((y1 - y0) * (x - x0)) / (x1 - x0)) * 100))
  })
}

/**
 * Curve values are bytes where 50 is 0% output and 150 is 100% (the stock ramp runs 50..150, and a
 * deadzone pushes the low points below 50, which the pad clamps to 0%). The nine points sit at evenly
 * spaced input positions (0, 12.5 … 100%): Space Station's deadzone writes are linear in the index.
 */
export const FX_CURVE_ZERO = 50
export const fxCurveRawToPercent = (raw: number): number => raw - FX_CURVE_ZERO
export const fxCurvePercentToRaw = (pct: number): number => Math.max(0, Math.min(255, Math.round(FX_CURVE_ZERO + pct)))

/**
 * Sample a designed curve (x, y pairs on a 0..max scale, x ascending, as the GameSir presets are)
 * onto the pad's nine evenly spaced input steps and return the nine raw bytes.
 */
export function fxCurveFromDesign(design: ReadonlyArray<{ x: number; y: number }>, max = 255): number[] {
  const pts = [...design].sort((a, b) => a.x - b.x)
  const at = (x: number): number => {
    if (x <= pts[0].x) return pts[0].y
    for (let k = 1; k < pts.length; k++) {
      if (x <= pts[k].x) {
        const a = pts[k - 1]
        const b = pts[k]
        return b.x === a.x ? b.y : a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x)
      }
    }
    return pts[pts.length - 1].y
  }
  return Array.from({ length: FX_CURVE_POINTS }, (_, i) => fxCurvePercentToRaw((at((i / (FX_CURVE_POINTS - 1)) * max) / max) * 100))
}

export function fxDecodeCurves(blob: Uint8Array): { left: FxCurve; right: FxCurve } {
  const rec = (o: number): FxCurve => ({
    type: blob[o],
    points: Array.from(blob.subarray(o + 1, o + 1 + FX_CURVE_POINTS)),
    circularity: blob[o + 10],
    edge: blob[o + 11]
  })
  return { left: rec(FX_OFF.curves), right: rec(FX_OFF.curves + 12) }
}

/**
 * Returns a copy of `blob` with one stick's curve record replaced. Space Station writes the
 * sensitivity type to both the curve record (790) and the main stick record (109 / 116), so this
 * sets both; otherwise a Custom curve could sit next to a main record that still says Default.
 */
export function fxSetCurve(blob: Uint8Array, side: 0 | 1, curve: FxCurve): Uint8Array {
  if (curve.points.length !== FX_CURVE_POINTS) throw new Error(`fx: a curve has ${FX_CURVE_POINTS} points`)
  const out = blob.slice()
  out[FX_OFF.joystick + side * 7] = curve.type & 0xff
  const o = FX_OFF.curves + side * 12
  out[o] = curve.type & 0xff
  curve.points.forEach((v, i) => (out[o + 1 + i] = v & 0xff))
  out[o + 10] = curve.circularity & 0xff
  out[o + 11] = curve.edge & 0xff
  return out
}

/**
 * Per-trigger record (7 bytes at 123 / 130): type, zero (Start slider), the two
 * curve points and end (End slider). Start/End are Space Station's slider values
 * as plain 0..255 bytes; see fxTriggerRange for the derived points.
 */
export interface FxTriggerRaw {
  type: number
  zero: number
  p1x: number
  p1y: number
  p2x: number
  p2y: number
  end: number
}

/**
 * A trigger record for Space Station's Start/End sliders (plain 0..255 numbers):
 * zero = start, end = end, and it derives the two curve points as (start, start)
 * and (end, end). Matches its writes for (start 20, end 255) -> 00 14 14 14 ff ff ff
 * and (start 0, end 110) -> 00 00 00 00 6e 6e 6e. `type` is kept.
 */
export function fxTriggerRange(t: FxTriggerRaw, start: number, end: number): FxTriggerRaw {
  return { ...t, zero: start, p1x: start, p1y: start, p2x: end, p2y: end, end }
}

export function fxDecodeTriggers(blob: Uint8Array): { left: FxTriggerRaw; right: FxTriggerRaw } {
  const rec = (o: number): FxTriggerRaw => ({
    type: blob[o],
    zero: blob[o + 1],
    p1x: blob[o + 2],
    p1y: blob[o + 3],
    p2x: blob[o + 4],
    p2y: blob[o + 5],
    end: blob[o + 6]
  })
  return { left: rec(FX_OFF.triggers), right: rec(FX_OFF.triggers + 7) }
}

/** Returns a copy of `blob` with one trigger's record replaced. */
export function fxSetTrigger(blob: Uint8Array, side: 0 | 1, t: FxTriggerRaw): Uint8Array {
  const out = blob.slice()
  const o = FX_OFF.triggers + side * 7
  out.set([t.type, t.zero, t.p1x, t.p1y, t.p2x, t.p2y, t.end].map((v) => v & 0xff), o)
  return out
}

// --- button remaps (key table: 32 entries x 3 bytes at offset 13) ---

/** Space Station's ControllerKey ids for the keys a Direwolf has (the table is indexed by key id). */
export const FX_KEY_NAMES: Readonly<Record<number, string>> = {
  0: 'D-pad Up',
  1: 'D-pad Right',
  2: 'D-pad Down',
  3: 'D-pad Left',
  4: 'A',
  5: 'B',
  6: 'Select',
  7: 'X',
  8: 'Y',
  9: 'Start',
  10: 'LB',
  11: 'RB',
  12: 'LT',
  13: 'RT',
  14: 'L3',
  15: 'R3',
  18: 'M1',
  19: 'M2',
  24: 'Menu',
  27: 'Home'
}
/** Keys in a sensible display order. */
export const FX_KEY_ORDER: readonly number[] = [4, 5, 7, 8, 10, 11, 12, 13, 6, 9, 24, 27, 0, 1, 2, 3, 14, 15, 18, 19]
export const FX_KEY_DEFAULT = 0xff
const FX_KEY_MACRO = 32

export interface FxKeyEntry {
  /** Key id this entry belongs to. */
  id: number
  /** 'key' = plain remap (target = FX_KEY_DEFAULT when unremapped); turbo/macro are shown but not edited. */
  kind: 'key' | 'turbo' | 'macro'
  target: number
}

export function fxDecodeKeys(blob: Uint8Array): FxKeyEntry[] {
  return FX_KEY_ORDER.map((id) => {
    const o = FX_OFF.keys + id * 3
    const [t, , freq] = [blob[o], blob[o + 1], blob[o + 2]]
    const kind = t === FX_KEY_MACRO ? 'macro' : freq > 0 ? 'turbo' : 'key'
    return { id, kind, target: t > FX_KEY_MACRO && t !== FX_KEY_DEFAULT ? FX_KEY_DEFAULT : t }
  })
}

/**
 * Point key `id` at `target` (FX_KEY_DEFAULT clears the remap). Writes the entry
 * as `[target, 0, 0]`, which is what Space Station writes for a plain remap
 * (A->B gave `05 00 00`). Turbo and macro entries are refused.
 */
export function fxSetKeyTarget(blob: Uint8Array, id: number, target: number): Uint8Array {
  if (!(id in FX_KEY_NAMES)) throw new Error(`fx: key ${id} is not a Direwolf key`)
  if (target !== FX_KEY_DEFAULT && !(target in FX_KEY_NAMES)) throw new Error(`fx: key ${id} cannot be mapped to ${target}`)
  const o = FX_OFF.keys + id * 3
  if (blob[o] === FX_KEY_MACRO || blob[o + 2] > 0) throw new Error(`fx: ${FX_KEY_NAMES[id]} has a turbo/macro entry; edit it in Space Station`)
  const out = blob.slice()
  out[o] = target & 0xff
  out[o + 1] = 0
  out[o + 2] = 0
  return out
}

// --- session-level shapes shared with the renderer ---

export interface FxSnapshot {
  /** Config slot shown (0-based; Space Station's 配置1 is 0). */
  cfgId: number
  /** Slot the pad is currently running, and how many slots it has. */
  activeCfgId: number
  cfgCount: number
  dataVersion: number
  vibration: FxVibration
  sticks: { left: FxStickRaw; right: FxStickRaw }
  curves: { left: FxCurve; right: FxCurve }
  triggers: { left: FxTriggerRaw; right: FxTriggerRaw }
  keys: FxKeyEntry[]
}

export interface FxPatch {
  /** Slot to edit (0-based); defaults to the pad's active slot. */
  cfgId?: number
  vibration?: FxVibration
  leftCenter?: number
  rightCenter?: number
  leftCurve?: FxCurve
  rightCurve?: FxCurve
  leftTrigger?: FxTriggerRaw
  rightTrigger?: FxTriggerRaw
  /** key id -> target key id (255 = default); only the keys listed are changed. */
  keys?: Record<number, number>
  /** Persist with the 0x50 save after a verified write (survives a replug). */
  save?: boolean
}
