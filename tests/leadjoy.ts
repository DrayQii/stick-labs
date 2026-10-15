// LeadJoy Saber Plus: framing + MessagePack + record codec.
// Vectors are byte-exact USBPcap captures (fixtures/leadjoy/*.bin are the
// reassembled vendor documents; inline hex frames are raw 64B reports).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LJ_BUTTON_QUERY_IDS,
  LJ_MAP_GAMEPAD,
  LJ_MAP_ORIGIN,
  ljBoardQuery,
  ljBuildButtonTable,
  ljBuildSnapshot,
  ljButtonQuery,
  ljButtonTarget,
  ljChecksum,
  ljDecodeStream,
  ljFrameOut,
  ljGlobalQuery,
  ljMotionDevicesQuery,
  ljMpDecode,
  ljMpEncode,
  ljParseBoard,
  ljParseButtonTable,
  ljParseSingleFrame,
  ljParseStick,
  ljParseTrigger,
  ljPercentToWire,
  ljReassemble,
  ljRumbleQuery,
  ljStickQuery,
  ljTriggerQuery,
  ljVersionQuery,
  ljWireToPercent,
  type LjButtonRecord
} from '../src/shared/leadjoy.ts'

let failures = 0
function check(name: string, cond: boolean): void {
  if (cond) console.log(`✓ ${name}`)
  else {
    console.error(`✗ ${name}`)
    failures++
  }
}
function hex(bytes: ArrayLike<number>): string {
  return Array.from({ length: bytes.length }, (_, i) => (bytes[i] ?? 0).toString(16).padStart(2, '0')).join('')
}
function unhex(text: string): number[] {
  const out: number[] = []
  for (let i = 0; i < text.length; i += 2) out.push(parseInt(text.slice(i, i + 2), 16))
  return out
}
function fixture(name: string): number[] {
  return Array.from(readFileSync(join(process.cwd(), 'fixtures', 'leadjoy', name)))
}

// --- OUT framing is byte-exact ---------------------------------------------
check(
  'version query exact',
  hex(ljVersionQuery().slice(0, 8)) === 'a508cc81a1630c0a'
)
check(
  'board query exact',
  hex(ljBoardQuery().slice(0, 11)) === 'a50bcc82a16333a1620139'
)
check(
  'button query slot0 exact',
  hex(ljButtonQuery(0).slice(0, 44)) ===
    'a52ccc82a1633ca16783a16201a16300a16bdc00161a1b1819010204050e0f111213140708090a0b100c0315'
)
check(
  'button query slot1 exact',
  hex(ljButtonQuery(1).slice(0, 44)) ===
    'a52ccc82a1633ca16783a16201a16301a16bdc00161a1b1819010204050e0f111213140708090a0b100c0316'
)
check(
  'button query slot2 exact',
  hex(ljButtonQuery(2).slice(0, 44)) ===
    'a52ccc82a1633ca16783a16201a16302a16bdc00161a1b1819010204050e0f111213140708090a0b100c0317'
)
check(
  'trigger query slot0 exact',
  hex(ljTriggerQuery(0).slice(0, 17)) === 'a511cc82a1635aa16782a16201a16300f4'
)
check('query ids vendor order', JSON.stringify([...LJ_BUTTON_QUERY_IDS]) === JSON.stringify([26, 27, 24, 25, 1, 2, 4, 5, 14, 15, 17, 18, 19, 20, 7, 8, 9, 10, 11, 16, 12, 3]))
check('frames are 64B zero-padded', ljButtonQuery(0).length === 64 && ljButtonQuery(0).slice(44).every((b) => b === 0))
check(
  'checksum covers the frame',
  ljChecksum(ljBoardQuery(), 10) === ljBoardQuery()[10]
)

// --- single-frame IN parses -------------------------------------------------
const verFrame = [...unhex('a516cc83a1630ca16500a172a833362e31362e31326a'), ...new Array(64 - 22).fill(0)]
const verDoc = ljParseSingleFrame(verFrame) as { c: number; e: number; r: string }
check('version reply decodes', verDoc.c === 12 && verDoc.e === 0 && verDoc.r === '36.16.12')

// --- fragmented IN reassembles (captured board-info pair) -------------------
const boardF1 = unhex('a440cc8283a16333a16500a17282a16201a2643283a16101a16ead44454641554c545f424f415244a36366679284a16301a26b6f01a2617400a16b9084a163d7')
const boardF2 = unhex('a411cc0102a26b6f01a2617400a16b90140000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000')
const boardStream = ljReassemble([boardF1, boardF2])
check('board reassembles to 71B', boardStream.stream.length === 71 && boardStream.total === 2)
check('board stream matches fixture', hex(boardStream.stream) === hex(fixture('board.bin')))
check('board parses', ljParseBoard(ljDecodeStream(boardStream.stream)).name === 'DEFAULT_BOARD')
const broken = [...boardF1]
broken[10] = (broken[10] ?? 0) ^ 0xff
try {
  ljReassemble([broken, boardF2])
  check('bad checksum rejected', false)
} catch {
  check('bad checksum rejected', true)
}

// --- button tables ----------------------------------------------------------
const btnMain = ljParseButtonTable(ljDecodeStream(fixture('btn-main.bin')))
check('button table slot/board', btnMain.slot === 0 && btnMain.board === 1)
check('button table has 22 records', btnMain.records.length === 22)
const mapped = btnMain.records.filter((r) => ljButtonTarget(r) !== null)
check('only m1 remapped', mapped.length === 1 && mapped[0]?.k === 24 && ljButtonTarget(mapped[0] as LjButtonRecord) === 'X')
const m1 = btnMain.records.find((r) => r.k === 24) as LjButtonRecord
check('m1 atom exact', m1.dn.t === LJ_MAP_GAMEPAD && JSON.stringify(m1.dn.v) === JSON.stringify([4, 0, 0, 0]))
const origin = btnMain.records.find((r) => r.k === 1) as LjButtonRecord
check('origin atom exact', origin.dn.t === LJ_MAP_ORIGIN && origin.dn.v.every((v) => v === 0) && ljButtonTarget(origin) === null)

const btnSub1 = ljParseButtonTable(ljDecodeStream(fixture('btn-sub1.bin')))
const btnSub2 = ljParseButtonTable(ljDecodeStream(fixture('btn-sub2.bin')))
check('subs all origin', btnSub1.records.every((r) => ljButtonTarget(r) === null))
check(
  'subs identical',
  JSON.stringify(btnSub1.records) === JSON.stringify(btnSub2.records)
)
// Clearing m1 in Main and re-encoding for slot 1 reproduces Sub1 byte-exact:
// the encoder is proven before any write path exists.
const cleared: LjButtonRecord[] = btnMain.records.map((r) =>
  r.k === 24
    ? { ...r, dn: { t: 0, n: '', mr: 0, ms: 0, r: 0, sp: 0, ri: 0, v: [0, 0, 0, 0] } }
    : r
)
check('re-encode reproduces sub1', hex(ljBuildButtonTable(1, cleared)) === hex(fixture('btn-sub1.bin')))

// --- sticks -----------------------------------------------------------------
const left = ljParseStick(ljDecodeStream(fixture('stick-left-main.bin')))
check('left head is 0%', left.curveWire[0]?.[0] === 0 && left.curveWire[0]?.[1] === 0)
check('left 16.6% step exact', left.curveWire[1]?.[0] === 5439 && left.curveWire[1]?.[1] === 5276)
check('left tail clamps', JSON.stringify(left.curveWire[7]) === JSON.stringify([32767, 32767]))
check('left center/shape/radii', left.center[0] === 0 && left.center[1] === 0 && left.shape === 1 && left.triggerRadius.left === 10)
const right = ljParseStick(ljDecodeStream(fixture('stick-right-main.bin')))
check('right 30% deadzone head', right.curveWire[0]?.[0] === 9830 && right.curveWire[0]?.[1] === 0)
check('right side/slot', right.side === 1 && right.slot === 0)
check('percent scale', ljPercentToWire(30) === 9830 && ljPercentToWire(100) === 32767 && Math.abs(ljWireToPercent(16384) - 50) < 1e-9)

// --- triggers / rumble / global ----------------------------------------------
const trig = ljParseTrigger(ljDecodeStream(fixture('trigger-main.bin')))
check(
  'trigger deadzones',
  trig.left.mode === 2 && trig.left.inner === 5 && trig.left.outer === 95 && trig.left.vibration === 0 &&
    trig.right.inner === 5 && trig.right.outer === 95
)
const rumbleDoc = ljDecodeStream(fixture('rumble-main.bin')) as { c: number; r: { d1: Record<string, number | number[]> } }
check('rumble envelope', rumbleDoc.c === 120 && (rumbleDoc.r.d1.enl as number) === 1)
const globalDoc = ljDecodeStream(fixture('global-main.bin')) as { c: number; r: { d1: Record<string, number | number[]> } }
check('global envelope', globalDoc.c === 100 && (globalDoc.r.d1.se as number) === 40)

// --- query builders stay byte-consistent ------------------------------------
check('stick query shape', hex(ljStickQuery(0, 1).slice(0, 20)) === hex(ljFrameOut({ c: 70, g: { b: 1, c: 0, d: 1 } }).slice(0, 20)))
check('global/rumble/motion queries build', ljGlobalQuery(0).length === 64 && ljRumbleQuery(0).length === 64 && ljMotionDevicesQuery().length === 64)

// --- msgpack codec round-trips ----------------------------------------------
const samples: Array<[string, unknown]> = [
  ['ints', [0, 1, 127, 128, 255, 256, 32767, 32768]],
  ['map', { c: 60, e: 0, r: { b: 1, c: 0 } }],
  ['strs', ['', 'DEFAULT_BOARD', 'Saber']],
  ['nested', [{ k: 24, a: 0, dn: { t: 2, n: '', v: [4, 0, 0, 0] } }]]
]
for (const [name, sample] of samples) {
  const enc = ljMpEncode(sample as never)
  const dec = ljMpDecode(enc, 0)
  check(`msgpack ${name}`, dec.next === enc.length && JSON.stringify(dec.value) === JSON.stringify(sample))
}

// --- snapshot -----------------------------------------------------------------
const snap = ljBuildSnapshot(
  { c: 12, e: 0, r: '36.16.12' },
  ljParseBoard(ljDecodeStream(fixture('board.bin'))),
  btnMain,
  left,
  right,
  trig
)
check('snapshot version/board', snap.version === '36.16.12' && snap.board === 'DEFAULT_BOARD' && snap.slot === 0)
check(
  'snapshot m1',
  snap.buttons.find((b) => b.id === 24)?.target === 'X' && snap.buttons.filter((b) => b.target !== null).length === 1
)
check(
  'snapshot deadzones',
  Math.abs((snap.sticks[0]?.deadzonePct ?? -1) - 0) < 1e-9 && Math.abs((snap.sticks[1]?.deadzonePct ?? -1) - 30) < 0.05
)

if (failures > 0) {
  console.error(`${failures} FAILURES`)
  process.exit(1)
} else console.log('ALL LEADJOY TESTS PASSED')
