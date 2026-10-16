/**
 * Flydigi XInput-mode config protocol (Direwolf 4, "fp4").
 *
 * Source: read from Space Station's own service code (Flydigi.ControllerSDK,
 * XInputProtocol) and proven on a Direwolf 4: read, write, readback and save
 * (docs/flydigi.md). Fixture: fixtures/flydigi/fp4-cfg1.bin is a real read.
 *
 * Transport (not here): commands are 15-byte buffers handed to Space
 * Station's Xbox 360 filter driver (XboxComm64.dll WriteData2Usb); replies
 * arrive inside 32-byte Xbox 360 input reports with A5 at [14], cmd at [15].
 *
 * The config is one blob split into 10-byte packs (V3.1: 84 packs = 840
 * bytes). A write sends only changed packs: 0x23 start, then 0x24 per pack.
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
const FX_MARK = 0xa0

/** Blob offsets (V3.0 layout). Unused bytes are 0xFF. */
export const FX_OFF = {
  protoVersion: 0, // u16 LE (0x0301 on this pad)
  keys: 13, // 32 keys x 3 bytes, to 109
  joystick: 109, // 2 x 7 bytes, to 123
  triggers: 123, // 14 bytes, to 137
  motion: 137, // 8 bytes, to 145
  vibration: 145, // 9 bytes, to 154
  dataVersion: 225 // u16 LE
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

// --- session-level shapes shared with the renderer ---

export interface FxSnapshot {
  cfgId: number
  dataVersion: number
  vibration: FxVibration
  sticks: { left: FxStickRaw; right: FxStickRaw }
}

export interface FxPatch {
  vibration?: FxVibration
  leftCenter?: number
  rightCenter?: number
  /** Persist with the 0x50 save after a verified write (survives a replug). */
  save?: boolean
}
