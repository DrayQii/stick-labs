/**
 * LeadJoy Saber Plus protocol (VID 0x4131 PID 0x3519, config on MI_04
 * usage page 0xFF80/0001, 64B HID reports, MessagePack payloads).
 *
 * Proven against hardware from Stick Labs' own handle (node-hid, report ID 0
 * + 64B payload): every query below round-trips byte-exact against USBPcap
 * captures of the vendor app, and every reply fixture under
 * fixtures/leadjoy/ decodes end-to-end with checksum verification.
 *
 * Framing (all integers are single bytes):
 * - OUT: [0xA5][LEN][0xCC][msgpack][CK], zero-padded to 64B.
 *   LEN covers the whole frame including CK. CK is the additive checksum
 *   `sum(all preceding frame bytes) & 0xFF`.
 * - IN single-frame: [0xA5][LEN][0xCC][msgpack][CK] (+ zero pad).
 * - IN fragmented: first frame [0xA4][0x40][0xCC][0x80|total][chunk][CK],
 *   middle frames [0xA4][0x40][0xCC][remaining][chunk][CK], final frame
 *   [0xA4][LEN<0x40][0xCC][0x01][chunk][CK] (+ zero pad). LEN covers the
 *   meaningful bytes including CK. Concatenating the chunks yields one
 *   MessagePack document.
 *
 * Record catalog (c = record id, b = board 1, c-slot = Main/Sub1/Sub2 0/1/2):
 * - 12: firmware/board version string (single-frame, r = e.g. "36.16.12").
 * - 51: board info {b, d2:{a, n:"DEFAULT_BOARD", cfg:[{c,ko,at,k}x2]}}.
 * - 60: button table {b, c:slot, d1:[22x {k,a,dn,up}]}. Source ids are the
 *   query ids; a remap target reuses the same id space (proven: R5/M1 id
 *   0x18 -> X id 4 arrives as dn {t:2, v:[4,0,0,0]}; Origin is t:0 v:[0,0,0,0]).
 * - 70: per-stick tuning {b, c:slot, d, d1:{co:[x,y] center, ci, cv:[16x]
 *   EightPoint curve as [in0,out0..in7,out7] in 0..32767 (percent*327.68,
 *   32768 clamps to 32767), cpl/cpu/cpr/cpd stick-trigger radii, ...}}.
 *   d = 0 left, 1 right.
 * - 90: triggers {b, c:slot, d1:{mol,dzl:[in,out],vtl,mor,dzr,vtr}}.
 * - 100: global/motion {b, c:slot, d1:{sj,tm,tk,kao,cv,se,hvr,...,ec,el}}.
 * - 120: rumble {b, c:slot, d1:{enl,grl,trl,trml,enr,grr,trr,trmr}}.
 * - 220: motion-control device colors [{mkn,c:[r,g,b],s}].
 *
 * Status: full READ model proven. No writes ship: the vendor save-flush
 * bytes are still uncaptured, so every write path stays locked until a
 * Save capture proves the write framing on hardware with readback.
 */

/** USB identity of the Saber Plus config interface (MI_04). */
export const LJ_VID = 0x4131
export const LJ_PID_SABER_PLUS = 0x3519
export const LJ_USAGE_PAGE = 0xff80
export const LJ_USAGE = 0x01
/** HID payload length; node-hid adds the leading 0x00 report id. */
export const LJ_REPORT_LEN = 64
/** Frame marker after the length byte. */
export const LJ_MARKER = 0xcc
/** OUT class (host->pad) and single-frame IN class. */
export const LJ_OUT_CLASS = 0xa5
/** Fragmented IN class (pad->host, multi-frame). */
export const LJ_IN_CLASS = 0xa4

/** Record ids. */
export const LJ_REC_VERSION = 12
export const LJ_REC_BOARD = 51
export const LJ_REC_BUTTONS = 60
export const LJ_REC_STICK = 70
export const LJ_REC_TRIGGER = 90
export const LJ_REC_GLOBAL = 100
export const LJ_REC_RUMBLE = 120
export const LJ_REC_MOTION_DEVICES = 220

/** Profile slots: Main, Sub1, Sub2. */
export const LJ_SLOTS = [0, 1, 2] as const
export type LjSlot = (typeof LJ_SLOTS)[number]

/** Curve scaling: wire = round(percent/100*32768), 100% clamps to 0x7FFF. */
export const LJ_WIRE_MAX = 0x7fff
export const LJ_CURVE_POINTS = 8

// ---------------------------------------------------------------------------
// Minimal MessagePack codec (only what this protocol uses).
// ---------------------------------------------------------------------------

/** Decoded document values. Binary blobs surface as number arrays. */
export type LjValue =
  | null
  | boolean
  | number
  | string
  | number[]
  | LjValue[]
  | { [key: string]: LjValue }

function utf8Bytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text))
}

function utf8Text(bytes: ArrayLike<number>, start: number, len: number): string {
  const slice = new Uint8Array(len)
  for (let i = 0; i < len; i++) slice[i] = bytes[start + i] ?? 0
  return new TextDecoder().decode(slice)
}

/** Encode a value with the same width choices the vendor firmware uses. */
export function ljMpEncode(value: LjValue): number[] {
  if (value === null || value === undefined) return [0xc0]
  if (typeof value === 'boolean') return [value ? 0xc3 : 0xc2]
  if (typeof value === 'number') {
    const n = Math.round(value)
    if (n >= 0 && n < 128) return [n]
    if (n >= 0 && n < 256) return [0xcc, n]
    if (n >= 0 && n < 65536) return [0xcd, (n >> 8) & 0xff, n & 0xff]
    if (n >= 0 && n < 4294967296) {
      return [0xce, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
    }
    if (n >= -32 && n < 0) return [n & 0xff]
    if (n >= -128 && n < 0) return [0xd0, n & 0xff]
    if (n >= -32768 && n < 0) return [0xd1, (n >> 8) & 0xff, n & 0xff]
    throw new Error(`ljMpEncode: int out of range ${value}`)
  }
  if (typeof value === 'string') {
    const raw = utf8Bytes(value)
    if (raw.length < 32) return [(0xa0 | raw.length) & 0xff, ...raw]
    if (raw.length < 256) return [0xd9, raw.length, ...raw]
    if (raw.length < 65536) return [0xda, (raw.length >> 8) & 0xff, raw.length & 0xff, ...raw]
    throw new Error(`ljMpEncode: string too long (${raw.length})`)
  }
  if (Array.isArray(value)) {
    const flat: number[] = []
    for (const item of value) flat.push(...ljMpEncode(item as LjValue))
    if (value.length < 16) return [(0x90 | value.length) & 0xff, ...flat]
    if (value.length < 65536) {
      return [0xdc, (value.length >> 8) & 0xff, value.length & 0xff, ...flat]
    }
    throw new Error(`ljMpEncode: array too long (${value.length})`)
  }
  const keys = Object.keys(value)
  const flat: number[] = []
  for (const key of keys) {
    flat.push(...ljMpEncode(key))
    flat.push(...ljMpEncode((value as Record<string, LjValue>)[key]))
  }
  if (keys.length < 16) return [(0x80 | keys.length) & 0xff, ...flat]
  if (keys.length < 65536) {
    return [0xde, (keys.length >> 8) & 0xff, keys.length & 0xff, ...flat]
  }
  throw new Error(`ljMpEncode: map too large (${keys.length})`)
}

export interface LjDecoded {
  value: LjValue
  next: number
}

/** Decode one value at an offset; `next` is the first unconsumed offset. */
export function ljMpDecode(bytes: ArrayLike<number>, pos = 0): LjDecoded {
  const prefix = bytes[pos] ?? -1
  if (prefix >= 0 && prefix < 0x80) return { value: prefix, next: pos + 1 }
  if (prefix >= 0x80 && prefix < 0x90) {
    const count = prefix & 0x0f
    let at = pos + 1
    const out: Record<string, LjValue> = {}
    for (let i = 0; i < count; i++) {
      const key = ljMpDecode(bytes, at)
      const val = ljMpDecode(bytes, key.next)
      if (typeof key.value !== 'string') throw new Error(`ljMpDecode: map key not a string at ${at}`)
      out[key.value] = val.value
      at = val.next
    }
    return { value: out, next: at }
  }
  if (prefix >= 0x90 && prefix < 0xa0) {
    const count = prefix & 0x0f
    let at = pos + 1
    const out: LjValue[] = []
    for (let i = 0; i < count; i++) {
      const item = ljMpDecode(bytes, at)
      out.push(item.value)
      at = item.next
    }
    return { value: out, next: at }
  }
  if (prefix >= 0xa0 && prefix < 0xc0) {
    const len = prefix & 0x1f
    return { value: utf8Text(bytes, pos + 1, len), next: pos + 1 + len }
  }
  if (prefix === 0xc0) return { value: null, next: pos + 1 }
  if (prefix === 0xc2) return { value: false, next: pos + 1 }
  if (prefix === 0xc3) return { value: true, next: pos + 1 }
  if (prefix === 0xc4 || prefix === 0xc5) {
    const len = prefix === 0xc4 ? (bytes[pos + 1] ?? 0) : (((bytes[pos + 1] ?? 0) << 8) | (bytes[pos + 2] ?? 0))
    const head = prefix === 0xc4 ? 2 : 3
    const out: number[] = []
    for (let i = 0; i < len; i++) out.push(bytes[pos + head + i] ?? 0)
    return { value: out, next: pos + head + len }
  }
  if (prefix === 0xcc) return { value: bytes[pos + 1] ?? 0, next: pos + 2 }
  if (prefix === 0xcd) {
    return { value: ((bytes[pos + 1] ?? 0) << 8) | (bytes[pos + 2] ?? 0), next: pos + 3 }
  }
  if (prefix === 0xce) {
    const v =
      (((bytes[pos + 1] ?? 0) * 0x1000000) +
        ((bytes[pos + 2] ?? 0) << 16) +
        ((bytes[pos + 3] ?? 0) << 8) +
        (bytes[pos + 4] ?? 0)) >>>
      0
    return { value: v, next: pos + 5 }
  }
  if (prefix === 0xd0) {
    const raw = bytes[pos + 1] ?? 0
    return { value: raw > 127 ? raw - 256 : raw, next: pos + 2 }
  }
  if (prefix === 0xd1) {
    const raw = (((bytes[pos + 1] ?? 0) << 8) | (bytes[pos + 2] ?? 0)) & 0xffff
    return { value: raw > 32767 ? raw - 65536 : raw, next: pos + 3 }
  }
  if (prefix === 0xd9) {
    const len = bytes[pos + 1] ?? 0
    return { value: utf8Text(bytes, pos + 2, len), next: pos + 2 + len }
  }
  if (prefix === 0xda) {
    const len = (((bytes[pos + 1] ?? 0) << 8) | (bytes[pos + 2] ?? 0)) & 0xffff
    return { value: utf8Text(bytes, pos + 3, len), next: pos + 3 + len }
  }
  if (prefix === 0xdc) {
    const count = (((bytes[pos + 1] ?? 0) << 8) | (bytes[pos + 2] ?? 0)) & 0xffff
    let at = pos + 3
    const out: LjValue[] = []
    for (let i = 0; i < count; i++) {
      const item = ljMpDecode(bytes, at)
      out.push(item.value)
      at = item.next
    }
    return { value: out, next: at }
  }
  if (prefix === 0xde) {
    const count = (((bytes[pos + 1] ?? 0) << 8) | (bytes[pos + 2] ?? 0)) & 0xffff
    let at = pos + 3
    const out: Record<string, LjValue> = {}
    for (let i = 0; i < count; i++) {
      const key = ljMpDecode(bytes, at)
      const val = ljMpDecode(bytes, key.next)
      if (typeof key.value !== 'string') throw new Error(`ljMpDecode: map key not a string at ${at}`)
      out[key.value] = val.value
      at = val.next
    }
    return { value: out, next: at }
  }
  if (prefix === 0xca || prefix === 0xcb) {
    const raw = new Uint8Array(prefix === 0xca ? 4 : 8)
    for (let i = 0; i < raw.length; i++) raw[i] = bytes[pos + 1 + i] ?? 0
    const view = new DataView(raw.buffer)
    return {
      value: prefix === 0xca ? view.getFloat32(0, false) : view.getFloat64(0, false),
      next: pos + 1 + raw.length
    }
  }
  if (prefix >= 0xe0) return { value: prefix - 256, next: pos + 1 }
  throw new Error(`ljMpDecode: unknown prefix 0x${(prefix & 0xff).toString(16)} at offset ${pos}`)
}

/** Decode a whole reassembled stream; throws on trailing bytes. */
export function ljDecodeStream(stream: ArrayLike<number>): LjValue {
  const { value, next } = ljMpDecode(stream, 0)
  if (next !== stream.length) {
    throw new Error(`ljDecodeStream: ${stream.length - next} trailing bytes after offset ${next}`)
  }
  return value
}

// ---------------------------------------------------------------------------
// Framing.
// ---------------------------------------------------------------------------

/** Additive checksum: sum(bytes[0..end)) & 0xFF. */
export function ljChecksum(bytes: ArrayLike<number>, end: number): number {
  let sum = 0
  for (let i = 0; i < end; i++) sum = (sum + (bytes[i] ?? 0)) & 0xff
  return sum
}

/**
 * Build one 64B OUT frame for a document. LEN covers the frame including
 * the checksum; the rest is zero padding (ignored by the pad).
 */
export function ljFrameOut(doc: LjValue): number[] {
  const body = ljMpEncode(doc)
  const len = 3 + body.length + 1
  if (len > LJ_REPORT_LEN) throw new Error(`ljFrameOut: document too large (${body.length} bytes)`)
  const frame = [LJ_OUT_CLASS, len, LJ_MARKER, ...body]
  frame.push(ljChecksum(frame, frame.length))
  while (frame.length < LJ_REPORT_LEN) frame.push(0)
  return frame
}

export interface LjReassembled {
  /** The concatenated MessagePack document bytes. */
  stream: number[]
  /** Total fragment count announced by the first frame (0x80|total). */
  total: number
}

/**
 * Reassemble fragmented IN frames (pcap/node-hid shape: each entry is one
 * 64B report starting with 0xA4). Verifies LEN/CK on every frame.
 */
export function ljReassemble(frames: ArrayLike<number>[]): LjReassembled {
  const stream: number[] = []
  let total = 0
  frames.forEach((frame, index) => {
    if (frame[0] !== LJ_IN_CLASS) throw new Error(`ljReassemble: frame ${index} class 0x${(frame[0] ?? 0).toString(16)}`)
    if (frame[2] !== LJ_MARKER) throw new Error(`ljReassemble: frame ${index} marker 0x${(frame[2] ?? 0).toString(16)}`)
    const len = frame[1] ?? 0
    if (len < 5 || len > LJ_REPORT_LEN) throw new Error(`ljReassemble: frame ${index} bad LEN ${len}`)
    const ck = frame[len - 1] ?? -1
    if (ljChecksum(frame, len - 1) !== ck) {
      throw new Error(`ljReassemble: frame ${index} checksum mismatch`)
    }
    const seq = frame[3] ?? 0
    if (index === 0) {
      if ((seq & 0x80) === 0) throw new Error('ljReassemble: first frame missing 0x80|total header')
      total = seq & 0x7f
      if (total !== frames.length) {
        throw new Error(`ljReassemble: announced ${total} frames, got ${frames.length}`)
      }
    } else if (seq !== total - index) {
      throw new Error(`ljReassemble: frame ${index} seq 0x${seq.toString(16)}, expected 0x${(total - index).toString(16)}`)
    }
    for (let i = 4; i < len - 1; i++) stream.push(frame[i] ?? 0)
  })
  return { stream, total }
}

/**
 * Parse one single-frame (0xA5) IN report. Returns the document; verifies
 * LEN/CK the same way fragmented frames are verified.
 */
export function ljParseSingleFrame(frame: ArrayLike<number>): LjValue {
  if (frame[0] !== LJ_OUT_CLASS) throw new Error('ljParseSingleFrame: not a 0xA5 frame')
  if (frame[2] !== LJ_MARKER) throw new Error('ljParseSingleFrame: bad marker')
  const len = frame[1] ?? 0
  if (len < 5 || len > LJ_REPORT_LEN) throw new Error(`ljParseSingleFrame: bad LEN ${len}`)
  const ck = frame[len - 1] ?? -1
  if (ljChecksum(frame, len - 1) !== ck) throw new Error('ljParseSingleFrame: checksum mismatch')
  const body: number[] = []
  for (let i = 3; i < len - 1; i++) body.push(frame[i] ?? 0)
  return ljDecodeStream(body)
}

// ---------------------------------------------------------------------------
// Query builders (byte-exact against vendor captures).
// ---------------------------------------------------------------------------

/** Session probe: firmware/board version string. */
export function ljVersionQuery(): number[] {
  return ljFrameOut({ c: LJ_REC_VERSION })
}

/** Board info ({c:51, b:1}). */
export function ljBoardQuery(): number[] {
  return ljFrameOut({ c: LJ_REC_BOARD, b: 1 })
}

/**
 * The 22 button ids the vendor app requests, in capture order. The pad
 * answers with the same 22 records sorted ascending.
 */
export const LJ_BUTTON_QUERY_IDS: ReadonlyArray<number> = [
  26, 27, 24, 25, 1, 2, 4, 5, 14, 15, 17, 18, 19, 20, 7, 8, 9, 10, 11, 16, 12, 3
]

/** Button table query for one slot. */
export function ljButtonQuery(slot: LjSlot): number[] {
  return ljFrameOut({ c: LJ_REC_BUTTONS, g: { b: 1, c: slot, k: [...LJ_BUTTON_QUERY_IDS] } })
}

/** Stick tuning query: d = 0 left, 1 right. */
export function ljStickQuery(slot: LjSlot, side: 0 | 1): number[] {
  return ljFrameOut({ c: LJ_REC_STICK, g: { b: 1, c: slot, d: side } })
}

/** Trigger (LT/RT deadzone + mode) query. */
export function ljTriggerQuery(slot: LjSlot): number[] {
  return ljFrameOut({ c: LJ_REC_TRIGGER, g: { b: 1, c: slot } })
}

/** Global/motion query. */
export function ljGlobalQuery(slot: LjSlot): number[] {
  return ljFrameOut({ c: LJ_REC_GLOBAL, g: { b: 1, c: slot } })
}

/** Rumble query. */
export function ljRumbleQuery(slot: LjSlot): number[] {
  return ljFrameOut({ c: LJ_REC_RUMBLE, g: { b: 1, c: slot } })
}

/** Motion-control device colors (global, no slot). */
export function ljMotionDevicesQuery(): number[] {
  return ljFrameOut({ c: LJ_REC_MOTION_DEVICES })
}

// ---------------------------------------------------------------------------
// Buttons.
// ---------------------------------------------------------------------------

/**
 * Source-id -> pad label, mirroring the vendor JSON button keys. Only R5=M1
 * (id 24) is hardware-confirmed so far; the rest follow the JSON order
 * alignment (a=1,b=2,x=4,y=5,l1=7,...,m1=24,m2=25,m3=26,m4=27,c=3), which the
 * single proven flip (m1->X) anchors.
 */
export const LJ_BUTTON_NAMES: Readonly<Record<number, string>> = {
  1: 'A',
  2: 'B',
  4: 'X',
  5: 'Y',
  7: 'L1',
  8: 'R1',
  9: 'L2',
  10: 'R2',
  11: 'Select',
  12: 'Start',
  14: 'L3',
  15: 'R3',
  16: 'Capture',
  17: 'Up',
  18: 'Down',
  19: 'Left',
  20: 'Right',
  24: 'M1',
  25: 'M2',
  26: 'M3',
  27: 'M4',
  3: 'C'
}

/** Remap targets reuse the source-id space (proven: X = 4). */
export function ljButtonTargetName(code: number): string {
  return LJ_BUTTON_NAMES[code] ?? `ID ${code}`
}

/** dn/up action payload. Origin = all zeros; GamepadButton sets t + v. */
export interface LjButtonAction {
  t: number
  n: string
  mr: number
  ms: number
  r: number
  sp: number
  ri: number
  v: number[]
}

export interface LjButtonRecord {
  k: number
  a: number
  dn: LjButtonAction
  up: LjButtonAction
}

function asRecord(value: LjValue): Record<string, LjValue> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('leadjoy: expected a map')
  }
  return value as Record<string, LjValue>
}

function asNumber(value: LjValue, what: string): number {
  if (typeof value !== 'number') throw new Error(`leadjoy: ${what} is not a number`)
  return value
}

function asString(value: LjValue, what: string): string {
  if (typeof value !== 'string') throw new Error(`leadjoy: ${what} is not a string`)
  return value
}

function asNumberArray(value: LjValue, what: string): number[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'number')) {
    throw new Error(`leadjoy: ${what} is not a number array`)
  }
  return value as number[]
}

function parseButtonAction(value: LjValue, what: string): LjButtonAction {
  const m = asRecord(value)
  return {
    t: asNumber(m.t, `${what}.t`),
    n: asString(m.n, `${what}.n`),
    mr: asNumber(m.mr, `${what}.mr`),
    ms: asNumber(m.ms, `${what}.ms`),
    r: asNumber(m.r, `${what}.r`),
    sp: asNumber(m.sp, `${what}.sp`),
    ri: asNumber(m.ri, `${what}.ri`),
    v: asNumberArray(m.v, `${what}.v`)
  }
}

function parseButtonRecord(value: LjValue): LjButtonRecord {
  const m = asRecord(value)
  return {
    k: asNumber(m.k, 'button.k'),
    a: asNumber(m.a, 'button.a'),
    dn: parseButtonAction(m.dn, 'button.dn'),
    up: parseButtonAction(m.up, 'button.up')
  }
}

export interface LjButtonTable {
  board: number
  slot: number
  records: LjButtonRecord[]
}

/** Parse a reassembled record-60 document. */
export function ljParseButtonTable(doc: LjValue): LjButtonTable {
  const root = asRecord(doc)
  if (asNumber(root.c, 'buttons.c') !== LJ_REC_BUTTONS) throw new Error('leadjoy: not a button table')
  const r = asRecord(root.r)
  const d1 = r.d1
  if (!Array.isArray(d1)) throw new Error('leadjoy: button d1 is not a list')
  if (d1.length !== LJ_BUTTON_QUERY_IDS.length) {
    throw new Error(`leadjoy: button table has ${d1.length} records, expected ${LJ_BUTTON_QUERY_IDS.length}`)
  }
  return {
    board: asNumber(r.b, 'buttons.r.b'),
    slot: asNumber(r.c, 'buttons.r.c'),
    records: (d1 as LjValue[]).map(parseButtonRecord)
  }
}

/** Re-encode a button table (modified or not) for a slot. No writes ship yet. */
export function ljBuildButtonTable(slot: LjSlot, records: ReadonlyArray<LjButtonRecord>): number[] {
  return ljMpEncode({
    c: LJ_REC_BUTTONS,
    e: 0,
    r: {
      b: 1,
      c: slot,
      d1: records.map((rec) => ({ k: rec.k, a: rec.a, dn: { ...rec.dn, v: [...rec.dn.v] }, up: { ...rec.up, v: [...rec.up.v] } }))
    }
  })
}

/** map_to discriminator: 0 = Origin (unmapped), 2 = GamepadButton (proven). */
export const LJ_MAP_ORIGIN = 0
export const LJ_MAP_GAMEPAD = 2

/** Human-readable mapping for one record: null when unmapped (Origin). */
export function ljButtonTarget(record: LjButtonRecord): string | null {
  if (record.dn.t === LJ_MAP_ORIGIN) return null
  if (record.dn.t === LJ_MAP_GAMEPAD && record.dn.v.length > 0) {
    return ljButtonTargetName(record.dn.v[0] ?? -1)
  }
  return `t=${record.dn.t} v=[${record.dn.v.join(',')}]`
}

// ---------------------------------------------------------------------------
// Sticks, triggers, board.
// ---------------------------------------------------------------------------

/** Percent (0..100) to wire (0..32767, 100% clamps from 32768). */
export function ljPercentToWire(percent: number): number {
  const raw = Math.round((percent / 100) * 32768)
  if (raw >= 32768) return LJ_WIRE_MAX
  return Math.max(0, raw)
}

/** Wire back to percent. */
export function ljWireToPercent(wire: number): number {
  return (wire / 32768) * 100
}

export interface LjStickTuning {
  board: number
  slot: number
  side: number
  /** Center offset in pad units. */
  center: [number, number]
  /** Shape code (1 = Circle in the current capture; enum otherwise open). */
  shape: number
  /** 8 [in,out] wire pairs, 0..32767. */
  curveWire: Array<readonly [number, number]>
  /** Same curve in percent for display. */
  curvePercent: Array<readonly [number, number]>
  /** Stick-trigger radii (left/up/right/down). */
  triggerRadius: { left: number; up: number; right: number; down: number }
  raw: LjValue
}

/** Parse a reassembled record-70 document (one stick side). */
export function ljParseStick(doc: LjValue): LjStickTuning {
  const root = asRecord(doc)
  if (asNumber(root.c, 'stick.c') !== LJ_REC_STICK) throw new Error('leadjoy: not a stick record')
  const r = asRecord(root.r)
  const d1 = asRecord(r.d1)
  const co = asNumberArray(d1.co, 'stick.co')
  const cv = asNumberArray(d1.cv, 'stick.cv')
  if (co.length !== 2) throw new Error('leadjoy: stick.co is not a pair')
  if (cv.length !== LJ_CURVE_POINTS * 2) {
    throw new Error(`leadjoy: stick.cv has ${cv.length} values, expected ${LJ_CURVE_POINTS * 2}`)
  }
  const pairs: Array<readonly [number, number]> = []
  for (let i = 0; i < LJ_CURVE_POINTS; i++) {
    pairs.push([cv[i * 2] ?? 0, cv[i * 2 + 1] ?? 0])
  }
  return {
    board: asNumber(r.b, 'stick.r.b'),
    slot: asNumber(r.c, 'stick.r.c'),
    side: asNumber(r.d, 'stick.r.d'),
    center: [co[0] ?? 0, co[1] ?? 0],
    shape: asNumber(d1.ci, 'stick.ci'),
    curveWire: pairs,
    curvePercent: pairs.map(([x, y]) => [ljWireToPercent(x), ljWireToPercent(y)] as const),
    triggerRadius: {
      left: asNumber(d1.cpl, 'stick.cpl'),
      up: asNumber(d1.cpu, 'stick.cpu'),
      right: asNumber(d1.cpr, 'stick.cpr'),
      down: asNumber(d1.cpd, 'stick.cpd')
    },
    raw: doc
  }
}

export interface LjTriggerTuning {
  board: number
  slot: number
  left: { mode: number; inner: number; outer: number; vibration: number }
  right: { mode: number; inner: number; outer: number; vibration: number }
}

/** Parse a reassembled record-90 document (LT/RT). */
export function ljParseTrigger(doc: LjValue): LjTriggerTuning {
  const root = asRecord(doc)
  if (asNumber(root.c, 'trigger.c') !== LJ_REC_TRIGGER) throw new Error('leadjoy: not a trigger record')
  const r = asRecord(root.r)
  const d1 = asRecord(r.d1)
  const dzl = asNumberArray(d1.dzl, 'trigger.dzl')
  const dzr = asNumberArray(d1.dzr, 'trigger.dzr')
  return {
    board: asNumber(r.b, 'trigger.r.b'),
    slot: asNumber(r.c, 'trigger.r.c'),
    left: {
      mode: asNumber(d1.mol, 'trigger.mol'),
      inner: dzl[0] ?? 0,
      outer: dzl[1] ?? 0,
      vibration: asNumber(d1.vtl, 'trigger.vtl')
    },
    right: {
      mode: asNumber(d1.mor, 'trigger.mor'),
      inner: dzr[0] ?? 0,
      outer: dzr[1] ?? 0,
      vibration: asNumber(d1.vtr, 'trigger.vtr')
    }
  }
}

export interface LjBoardInfo {
  board: number
  name: string
}

/** Parse a reassembled record-51 document. */
export function ljParseBoard(doc: LjValue): LjBoardInfo {
  const root = asRecord(doc)
  if (asNumber(root.c, 'board.c') !== LJ_REC_BOARD) throw new Error('leadjoy: not a board record')
  const r = asRecord(root.r)
  const d2 = asRecord(r.d2)
  return { board: asNumber(r.b, 'board.r.b'), name: asString(d2.n, 'board.n') }
}

// ---------------------------------------------------------------------------
// Read-only snapshot for the app preview (plain JSON, no writes involved).
// ---------------------------------------------------------------------------

export interface LjSnapshotButton {
  id: number
  label: string
  target: string | null
}

export interface LjSnapshotStick {
  side: number
  sideName: string
  deadzonePct: number
  center: [number, number]
  shape: number
  curvePct: Array<readonly [number, number]>
}

export interface LjSnapshotTriggerSide {
  mode: number
  inner: number
  outer: number
}

export interface LjSnapshot {
  version: string
  board: string
  slot: number
  buttons: LjSnapshotButton[]
  sticks: LjSnapshotStick[]
  trigger: { left: LjSnapshotTriggerSide; right: LjSnapshotTriggerSide }
}

function snapshotStick(tuning: LjStickTuning): LjSnapshotStick {
  return {
    side: tuning.side,
    sideName: tuning.side === 0 ? 'Left' : 'Right',
    deadzonePct: tuning.curvePercent[0]?.[0] ?? 0,
    center: tuning.center,
    shape: tuning.shape,
    curvePct: tuning.curvePercent
  }
}

/** Assemble one read-only snapshot from parsed Main-slot records. */
export function ljBuildSnapshot(
  versionDoc: LjValue,
  board: LjBoardInfo,
  buttons: LjButtonTable,
  left: LjStickTuning,
  right: LjStickTuning,
  trigger: LjTriggerTuning
): LjSnapshot {
  const version = asRecord(versionDoc)
  return {
    version: asString(version.r, 'version.r'),
    board: board.name,
    slot: buttons.slot,
    buttons: buttons.records.map((rec) => ({
      id: rec.k,
      label: LJ_BUTTON_NAMES[rec.k] ?? `ID ${rec.k}`,
      target: ljButtonTarget(rec)
    })),
    sticks: [snapshotStick(left), snapshotStick(right)],
    trigger: {
      left: { mode: trigger.left.mode, inner: trigger.left.inner, outer: trigger.left.outer },
      right: { mode: trigger.right.mode, inner: trigger.right.inner, outer: trigger.right.outer }
    }
  }
}
