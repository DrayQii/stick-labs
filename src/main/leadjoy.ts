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
  ljBuildButtonWrite,
  ljBuildSnapshot,
  ljButtonQuery,
  ljDecodeStream,
  ljFragmentOut,
  ljParseBoard,
  ljParseButtonTable,
  ljParseSingleFrame,
  ljParseStick,
  ljParseTrigger,
  ljParseWriteAck,
  ljReassemble,
  ljStickQuery,
  ljTriggerQuery,
  ljVersionQuery,
  type LjButtonRecord,
  type LjButtonTable,
  type LjSlot,
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
  const handle = openHandle(path)
  try {
    const version = ljDecodeStream(await queryStream(handle, ljVersionQuery()))
    const board = ljDecodeStream(await queryStream(handle, ljBoardQuery()))
    const table = await readButtonTable(handle, 0)
    const left = ljDecodeStream(await queryStream(handle, ljStickQuery(0, 0)))
    const right = ljDecodeStream(await queryStream(handle, ljStickQuery(0, 1)))
    const trigger = ljDecodeStream(await queryStream(handle, ljTriggerQuery(0)))
    return ljBuildSnapshot(
      version,
      ljParseBoard(board),
      table,
      ljParseStick(left),
      ljParseStick(right),
      ljParseTrigger(trigger)
    )
  } finally {
    closeHandle(handle)
  }
}

export interface LjButtonWriteResult {
  /** The pad's read-back carries the record we sent. */
  verified: boolean
  /** On mismatch the original record was written back (single attempt). */
  restored: boolean
}

/**
 * Write one button record and prove it landed (implemented, live proof
 * gated on explicit per-step user confirmation — never call this without it).
 *
 * Mirrors the vendor save-flush: the two OUT fragments go out back-to-back,
 * then the single-frame {c:61,e:0} ack is awaited before anything else.
 * The table is read first (rollback source) and read back after; on a
 * mismatch the original record is written back once and the call still
 * throws, reporting whether the restore verified.
 */
export async function ljWriteButtonVerified(
  path: string,
  slot: LjSlot,
  record: LjButtonRecord
): Promise<LjButtonWriteResult> {
  const handle = openHandle(path)
  try {
    const before = await readButtonTable(handle, slot)
    const original = before.records.find((r) => r.k === record.k)
    if (!original) throw new Error(`leadjoy: button id ${record.k} not in the table`)

    await writeRecord(handle, slot, record)
    const landed = await readButtonTable(handle, slot)
    if (recordsEqual(landed.records.find((r) => r.k === record.k), record)) {
      return { verified: true, restored: false }
    }

    await writeRecord(handle, slot, original)
    const afterRestore = await readButtonTable(handle, slot)
    const restored = recordsEqual(afterRestore.records.find((r) => r.k === record.k), original)
    throw new Error(
      `leadjoy: button id ${record.k} did not verify on readback (restore ${restored ? 'verified' : 'UNVERIFIED'} — re-read before writing again)`
    )
  } finally {
    closeHandle(handle)
  }
}

function openHandle(path: string): HIDInstance {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('leadjoy: refusing without a device path')
  }
  try {
    return new HIDModule.HID(path)
  } catch (err) {
    throw new Error(`leadjoy: cannot open device (close the LeadJoy app first) — ${(err as Error).message}`)
  }
}

function closeHandle(handle: HIDInstance): void {
  try {
    handle.close()
  } catch {
    /* already gone */
  }
}

async function readButtonTable(handle: HIDInstance, slot: LjSlot): Promise<LjButtonTable> {
  return ljParseButtonTable(ljDecodeStream(await queryStream(handle, ljButtonQuery(slot))))
}

/** Send one single-record write and await its {c:61,e:0} ack. */
async function writeRecord(handle: HIDInstance, slot: LjSlot, record: LjButtonRecord): Promise<void> {
  for (const fragment of ljFragmentOut(ljBuildButtonWrite(slot, record))) {
    handle.write([0x00, ...fragment])
  }
  const deadline = Date.now() + QUERY_TIMEOUT_MS
  for (;;) {
    if (Date.now() > deadline) throw new Error('leadjoy: timed out waiting for the write ack')
    const bytes = nextReport(handle)
    if (!bytes) continue
    if (bytes[0] === 0xa5) {
      ljParseWriteAck(ljParseSingleFrame(bytes))
      return
    }
    throw new Error(`leadjoy: unexpected reply to write (class 0x${(bytes[0] ?? 0).toString(16)})`)
  }
}

function recordsEqual(a: LjButtonRecord | undefined, b: LjButtonRecord): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Send one 64B query frame, collect and reassemble its reply stream. */
async function queryStream(handle: HIDInstance, frame: number[]): Promise<number[]> {
  handle.write([0x00, ...frame])
  const frames: number[][] = []
  const deadline = Date.now() + QUERY_TIMEOUT_MS
  for (;;) {
    if (Date.now() > deadline) throw new Error('leadjoy: query timed out waiting for a reply')
    const bytes = nextReport(handle)
    if (!bytes) continue
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

/** Next non-empty 64B input report, or null on timeout. Throws on transport errors. */
function nextReport(handle: HIDInstance): number[] | null {
  let raw: unknown
  try {
    raw = handle.readTimeout(READ_TIMEOUT_MS)
  } catch (err) {
    throw new Error(`leadjoy: read failed — ${(err as Error).message}`)
  }
  if (raw === null || raw === undefined) return null
  const bytes = toArray(raw)
  if (bytes.length === 0 || bytes.every((b) => b === 0)) return null
  if (bytes.length !== LJ_REPORT_LEN) {
    throw new Error(`leadjoy: ${bytes.length}B report, expected ${LJ_REPORT_LEN}B`)
  }
  return bytes
}
