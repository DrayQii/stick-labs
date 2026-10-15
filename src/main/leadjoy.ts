/**
 * LeadJoy Saber Plus read session (MI_04, usage page 0xFF80/0001).
 *
 * READ-ONLY: every query below comes from the shared builders proven
 * byte-exact against vendor captures in tests/leadjoy.ts — the same bytes
 * the vendor app sends while opening its mapping page. There is deliberately
 * no write path here: writes stay locked until a vendor save-flush capture
 * proves the write framing with readback.
 */
import HIDModule, { type HID as HIDInstance } from 'node-hid'
import {
  LJ_REPORT_LEN,
  ljBoardQuery,
  ljBuildSnapshot,
  ljButtonQuery,
  ljDecodeStream,
  ljParseBoard,
  ljParseButtonTable,
  ljParseSingleFrame,
  ljParseStick,
  ljParseTrigger,
  ljReassemble,
  ljStickQuery,
  ljTriggerQuery,
  ljVersionQuery,
  type LjSnapshot
} from '../shared/leadjoy'

const QUERY_TIMEOUT_MS = 10000
const READ_TIMEOUT_MS = 1500
const MAX_FRAMES = 40

function toArray(raw: unknown): number[] {
  if (raw instanceof Buffer) return Array.from(raw.values())
  if (raw instanceof Uint8Array) return Array.from(raw)
  if (Array.isArray(raw)) return raw.map((v) => Number(v) & 0xff)
  throw new Error('leadjoy: unexpected report shape')
}

/**
 * Read one Main-slot snapshot: version, board, buttons, both sticks,
 * triggers. Opens the interface, runs the vendor navigation reads, closes.
 * Throws when the handle is held (close the LeadJoy app) or a query times out.
 */
export async function ljReadMainSnapshot(path: string): Promise<LjSnapshot> {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('leadjoy: refusing read without a device path')
  }
  let handle: HIDInstance
  try {
    handle = new HIDModule.HID(path)
  } catch (err) {
    throw new Error(`leadjoy: cannot open device (close the LeadJoy app first) — ${(err as Error).message}`)
  }
  try {
    const version = ljDecodeStream(await runFrame(handle, ljVersionQuery()))
    const board = ljDecodeStream(await runFrame(handle, ljBoardQuery()))
    const buttons = ljDecodeStream(await runFrame(handle, ljButtonQuery(0)))
    const left = ljDecodeStream(await runFrame(handle, ljStickQuery(0, 0)))
    const right = ljDecodeStream(await runFrame(handle, ljStickQuery(0, 1)))
    const trigger = ljDecodeStream(await runFrame(handle, ljTriggerQuery(0)))
    return ljBuildSnapshot(
      version,
      ljParseBoard(board),
      ljParseButtonTable(buttons),
      ljParseStick(left),
      ljParseStick(right),
      ljParseTrigger(trigger)
    )
  } finally {
    try {
      handle.close()
    } catch {
      /* already gone */
    }
  }
}

/** Send one 64B query frame, collect and reassemble its reply stream. */
async function runFrame(handle: HIDInstance, frame: number[]): Promise<number[]> {
  handle.write([0x00, ...frame])
  const frames: number[][] = []
  const deadline = Date.now() + QUERY_TIMEOUT_MS
  for (;;) {
    if (Date.now() > deadline) throw new Error('leadjoy: query timed out waiting for a reply')
    let raw: unknown
    try {
      raw = handle.readTimeout(READ_TIMEOUT_MS)
    } catch (err) {
      throw new Error(`leadjoy: read failed — ${(err as Error).message}`)
    }
    if (raw === null || raw === undefined) continue
    const bytes = toArray(raw)
    if (bytes.length === 0 || bytes.every((b) => b === 0)) continue
    if (bytes.length !== LJ_REPORT_LEN) {
      throw new Error(`leadjoy: ${bytes.length}B report, expected ${LJ_REPORT_LEN}B`)
    }
    if (bytes[0] === 0xa5) {
      if (frames.length > 0) throw new Error('leadjoy: single-frame reply inside a fragment chain')
      // Verified (LEN + checksum) by the shared codec; slice the body out.
      ljParseSingleFrame(bytes)
      const len = bytes[1] ?? 0
      return bytes.slice(3, len - 1)
    }
    if (bytes[0] === 0xa4) {
      frames.push(bytes)
      if (frames.length > MAX_FRAMES) throw new Error('leadjoy: reply chain too long')
      if ((bytes[1] ?? 0) < LJ_REPORT_LEN) return ljReassemble(frames).stream
      continue
    }
    throw new Error(`leadjoy: unexpected reply class 0x${(bytes[0] ?? 0).toString(16)}`)
  }
}
