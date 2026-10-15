// LeadJoy Saber Plus: framing + MessagePack + record codec.
// Vectors are byte-exact USBPcap captures (fixtures/leadjoy/*.bin are the
// reassembled vendor documents; inline hex frames are raw 64B reports).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LJ_BUTTON_QUERY_IDS,
  LJ_MAP_GAMEPAD,
  LJ_MAP_KEYBOARD,
  LJ_MAP_MOUSE,
  LJ_MAP_ORIGIN,
  LJ_SHAPES,
  ljBoardQuery,
  ljBuildButtonTable,
  ljBuildButtonWrite,
  ljBuildSnapshot,
  ljButtonQuery,
  ljButtonWriteRecord,
  ljApplyStickPatch,
  ljBuildStickWrite,
  ljBuildTriggerWrite,
  ljCurveZones,
  ljFitZones,
  ljLinearCurve,
  ljNormZones,
  ljSampleDesign,
  ljButtonRecordTarget,
  ljButtonTarget,
  ljChecksum,
  ljDecodeStream,
  ljFrameBytes,
  ljFrameOut,
  ljFragmentOut,
  ljGlobalQuery,
  ljMotionDevicesQuery,
  ljMpDecode,
  ljMpEncode,
  ljParseBoard,
  ljParseButtonTable,
  ljParseSingleFrame,
  ljParseStick,
  ljParseStickSide,
  ljParseTriggerD1,
  ljParseTrigger,
  ljParseWriteAck,
  ljPercentToWire,
  ljReassemble,
  ljRumbleQuery,
  ljStickQuery,
  ljTriggerQuery,
  ljValidateCurveWire,
  ljValidateShape,
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

// --- single-record writes (save-flush capture) --------------------------------
function originAction(): { t: number; n: string; mr: number; ms: number; r: number; sp: number; ri: number; v: number[] } {
  return { t: 0, n: '', mr: 0, ms: 0, r: 0, sp: 0, ri: 0, v: [0, 0, 0, 0] }
}
// All four captured flips decode to their JSON targets (A=1 B=2 X=4 Y=5).
const writeTargets: Array<[number, number[]]> = [
  [24, [4, 0, 0, 0]],
  [25, [2, 0, 0, 0]],
  [26, [1, 0, 0, 0]],
  [27, [5, 0, 0, 0]]
]
for (const [id, v] of writeTargets) {
  const doc = ljDecodeStream(fixture(`wr-${id}-stream.bin`)) as unknown as {
    c: number
    w: { b: number; c: number; d1: Array<{ k: number; a: number; dn: { t: number; v: number[] } }> }
  }
  const rec = doc.w.d1[0]
  check(
    `write k=${id} -> v=[${v[0]}]`,
    doc.c === 61 && doc.w.b === 1 && doc.w.c === 0 && rec?.k === id && rec?.a === 0 &&
      rec?.dn.t === LJ_MAP_GAMEPAD && JSON.stringify(rec?.dn.v) === JSON.stringify(v)
  )
}
// Rebuilding M2->B with the vendor key order reproduces the capture byte-exact.
const m2write = ljBuildButtonWrite(0, {
  k: 25,
  a: 0,
  dn: { t: 2, n: '', mr: 0, ms: 0, r: 0, sp: 0, ri: 0, v: [2, 0, 0, 0] },
  up: originAction()
})
check('write doc byte-exact', hex(m2write) === hex(fixture('wr-25-stream.bin')))
// Fragmenting it reproduces the two captured OUT frames byte-exact.
const wrFrames = ljFragmentOut(m2write)
check('write fragments byte-exact', hex(wrFrames.flat()) === hex(fixture('wr-25-frames.bin')))
check('write fragments reassemble', hex(ljReassemble(wrFrames).stream) === hex(m2write))
// The pad acks each write with a single-frame {c:61,e:0}.
const ackFrame = [...unhex('a50bcc82a1633da1650045'), ...new Array(64 - 11).fill(0)]
check('write ack parses', JSON.stringify(ljParseWriteAck(ljParseSingleFrame(ackFrame), 61)) === JSON.stringify({ record: 61 }))
try {
  ljParseWriteAck({ c: 60, e: 0 }, 61)
  check('wrong ack rejected', false)
} catch {
  check('wrong ack rejected', true)
}
try {
  ljParseWriteAck({ c: 61, e: 1 }, 61)
  check('error ack rejected', false)
} catch {
  check('error ack rejected', true)
}
// Small documents fragment to a single 0x81 frame and round-trip.
const tiny = ljMpEncode({ c: 12 })
const tinyFrames = ljFragmentOut(tiny)
check(
  'single fragment round-trips',
  tinyFrames.length === 1 && (tinyFrames[0]?.[3] ?? 0) === 0x81 && hex(ljReassemble(tinyFrames).stream) === hex(tiny)
)

// --- target gate (stock / gamepad / keyboard / mouse) -------------------------
check(
  'gate builds R4->A',
  JSON.stringify(ljButtonWriteRecord(26, { t: LJ_MAP_GAMEPAD, code: 1 }).dn) ===
    JSON.stringify({ t: 2, n: '', mr: 0, ms: 0, r: 0, sp: 0, ri: 0, v: [1, 0, 0, 0] })
)
check(
  'gate builds stock',
  ljButtonWriteRecord(25, null).dn.t === LJ_MAP_ORIGIN && ljButtonWriteRecord(25, null).up.v.every((v) => v === 0)
)
check(
  'gate builds a keyboard key (HID usage in v[1])',
  JSON.stringify(ljButtonWriteRecord(24, { t: LJ_MAP_KEYBOARD, code: 22 }).dn) ===
    JSON.stringify({ t: 3, n: '', mr: 0, ms: 0, r: 0, sp: 0, ri: 0, v: [0, 22, 0, 0] })
)
check(
  'gate builds a mouse button (HID number in v[0])',
  JSON.stringify(ljButtonWriteRecord(25, { t: LJ_MAP_MOUSE, code: 2 }).dn) ===
    JSON.stringify({ t: 4, n: '', mr: 0, ms: 0, r: 0, sp: 0, ri: 0, v: [2, 0, 0, 0] })
)
for (const [id, target] of [
  [99, null],
  [24, { t: LJ_MAP_GAMEPAD, code: 99 }],
  [1, { t: LJ_MAP_GAMEPAD, code: 0 }],
  [26, { t: LJ_MAP_GAMEPAD, code: 256 }],
  [0, null],
  [24, { t: LJ_MAP_KEYBOARD, code: 200 }],
  [24, { t: LJ_MAP_MOUSE, code: 9 }],
  [24, { t: 1, code: 1 }]
] as Array<[number, { t: number; code: number } | null]>) {
  try {
    ljButtonWriteRecord(id, target)
    check(`gate refuses id=${id} target=${JSON.stringify(target)}`, false)
  } catch {
    check(`gate refuses id=${id} target=${JSON.stringify(target)}`, true)
  }
}
check(
  'gate builds A->B',
  JSON.stringify(ljButtonWriteRecord(1, { t: LJ_MAP_GAMEPAD, code: 2 })) ===
    JSON.stringify({ k: 1, a: 0, dn: { t: 2, n: '', mr: 0, ms: 0, r: 0, sp: 0, ri: 0, v: [2, 0, 0, 0] }, up: { t: 0, n: '', mr: 0, ms: 0, r: 0, sp: 0, ri: 0, v: [0, 0, 0, 0] } })
)

// --- keyboard / mouse targets (bound in the vendor app, read off the pad) -----
// Anchors: G = 10, O = 18, S = 22 (USB HID usages), L5 = mouse button 2.
const btnKb = ljParseButtonTable(ljDecodeStream(fixture('btn-kb-main.bin')))
const kbRec = (k: number): LjButtonRecord => btnKb.records.find((r) => r.k === k) as LjButtonRecord
check(
  'keyboard record decodes (R5 -> S)',
  JSON.stringify(ljButtonRecordTarget(kbRec(24))) === JSON.stringify({ t: 3, code: 22 }) && ljButtonTarget(kbRec(24)) === 'S'
)
check(
  'mouse record decodes (L5 -> right click)',
  JSON.stringify(ljButtonRecordTarget(kbRec(25))) === JSON.stringify({ t: 4, code: 2 }) && ljButtonTarget(kbRec(25)) === 'Right Click'
)
check('keyboard O and G decode', ljButtonTarget(kbRec(26)) === 'O' && ljButtonTarget(kbRec(27)) === 'G')
check(
  'keyboard/mouse actions rebuild byte-identical',
  [24, 25, 26, 27].every(
    (k) => JSON.stringify(ljButtonWriteRecord(k, ljButtonRecordTarget(kbRec(k))).dn) === JSON.stringify(kbRec(k).dn)
  )
)

// --- stick writes (curve-flip capture) ----------------------------------------
interface LjWriteDoc {
  c: number
  w: { b: number; c: number; d: number; d1: import('../src/shared/leadjoy.ts').LjValue }
}
const wrRight = ljDecodeStream(fixture('stick-wr-right.bin')) as unknown as LjWriteDoc
const wrLeft = ljDecodeStream(fixture('stick-wr-left.bin')) as unknown as LjWriteDoc
check(
  'stick write envelope',
  wrRight.c === 71 && wrRight.w.b === 1 && wrRight.w.c === 0 && wrRight.w.d === 1 &&
    wrLeft.c === 71 && wrLeft.w.d === 0
)
const d1Right = ljParseStickSide(wrRight.w.d1)
const d1Left = ljParseStickSide(wrLeft.w.d1)
check('right deadzone 25% head', d1Right.cv[0] === 8192 && d1Right.cv[1] === 0)
check('left deadzone 10% head', d1Left.cv[0] === 3277 && d1Left.cv[1] === 0)
check('stick write rebuild right byte-exact', hex(ljBuildStickWrite(0, 1, d1Right)) === hex(fixture('stick-wr-right.bin')))
check('stick write rebuild left byte-exact', hex(ljBuildStickWrite(0, 0, d1Left)) === hex(fixture('stick-wr-left.bin')))
check(
  'stick fragments byte-exact',
  hex(ljFragmentOut(fixture('stick-wr-right.bin')).flat()) === hex(fixture('stick-wr-right-frames.bin'))
)
const ack71 = [...unhex('a50bcc82a16347a165004f'), ...new Array(64 - 11).fill(0)]
check('stick ack parses', JSON.stringify(ljParseWriteAck(ljParseSingleFrame(ack71), 71)) === JSON.stringify({ record: 71 }))
check('percent anchors', ljPercentToWire(25) === 8192 && ljPercentToWire(10) === 3277)

// --- stick zones (deadzone / anti-deadzone / outer on the 8-point curve) ------
check('shape codes match the pad', LJ_SHAPES.Circle === 1 && LJ_SHAPES.RoundedRectangle === 0)
check('shape validator accepts both proven codes', ljValidateShape(0) === 0 && ljValidateShape(1) === 1)
for (const bad of [2, -1, 0.5, 'circle', null]) {
  let threw = false
  try {
    ljValidateShape(bad)
  } catch {
    threw = true
  }
  check(`shape validator refuses ${JSON.stringify(bad)}`, threw)
}
const shapedRect = ljDecodeStream(ljBuildStickWrite(0, 1, { ...d1Right, ci: LJ_SHAPES.RoundedRectangle })) as unknown as { w: { d1: unknown } }
check('shape write carries the new gate code', ljParseStickSide(shapedRect.w.d1).ci === 0 && d1Right.ci !== 0)

// --- stick patch (validated field-level writes on the record-71 image) --------
const patched = ljApplyStickPatch(d1Right, { ci: 0, mm: 1, mse: 77 })
check(
  'stick patch applies, others pass through',
  patched.ci === 0 && patched.mm === 1 && patched.mse === 77 && patched.rjc === d1Right.rjc &&
    JSON.stringify(patched.cv) === JSON.stringify(d1Right.cv) && patched.cpl === d1Right.cpl
)
check('stick patch copies rather than mutates', d1Right.ci !== 0 && d1Right.mm !== 1)
for (const bad of [{ mm: 2 }, { mse: 101 }, { mse: 1.5 }, { xr: -1 }, { ci: 7 }]) {
  let threw = false
  try {
    ljApplyStickPatch(d1Right, bad)
  } catch {
    threw = true
  }
  check(`stick patch refuses ${JSON.stringify(bad)}`, threw)
}
const grid10 = (pts: ReadonlyArray<readonly [number, number]>): Array<[number, number]> =>
  pts.map(([x, y]) => [Math.round(x * 10), Math.round(y * 10)])
const zRight = ljCurveZones(grid10(right.curvePercent))
check('zones read off the pad curve', zRight.start === 300 && zRight.antiStart === 0 && zRight.end === 1000 && zRight.antiEnd === 1000)
const fitted = ljFitZones(grid10(right.curvePercent), { start: 450, antiStart: 60, end: 950, antiEnd: 990 })
check('zone fit lands on both endpoints', fitted[0][0] === 450 && fitted[0][1] === 60 && fitted[7][0] === 950 && fitted[7][1] === 990)
check('zone fit keeps inputs ordered', fitted.every((p, i) => i === 0 || p[0] >= fitted[i - 1][0]))
check('zone fit leaves the pad curve alone', JSON.stringify(ljFitZones(grid10(right.curvePercent), zRight)) === JSON.stringify(grid10(right.curvePercent)))
const lin = ljLinearCurve({ start: 100, antiStart: 0, end: 1000, antiEnd: 1000 })
check('linear spans the zones', lin[0][0] === 100 && lin[0][1] === 0 && lin[7][0] === 1000 && lin[7][1] === 1000)
check('linear is monotonic', lin.every((p, i) => i === 0 || (p[0] > lin[i - 1][0] && p[1] > lin[i - 1][1])))
const design = [{ x: 0, y: 0 }, { x: 128, y: 100 }, { x: 255, y: 255 }]
const sampled = ljSampleDesign(design, { start: 200, antiStart: 0, end: 1000, antiEnd: 1000 })
check('design sample pins zone endpoints', sampled[0][0] === 200 && sampled[0][1] === 0 && sampled[7][0] === 1000 && sampled[7][1] === 1000)
check('design sample keeps inputs ordered', sampled.every((p, i) => i === 0 || p[0] > sampled[i - 1][0]))
check('design sample honours a floor', ljSampleDesign(design, { start: 0, antiStart: 400, end: 1000, antiEnd: 1000 })[0][1] === 400)
let zoneThrew = false
try {
  ljNormZones({ start: 900, antiStart: 0, end: 100, antiEnd: 1000 })
} catch {
  zoneThrew = true
}
check('zones refuse start past end', zoneThrew)
check('zones clamp negatives', ljNormZones({ start: -5, antiStart: 0, end: 1000, antiEnd: 1000 }).start === 0)

// --- trigger writes (deadzone-flip capture) -----------------------------------
const trigWr = ljDecodeStream(fixture('trig-wr-main.bin')) as unknown as {
  c: number
  w: { b: number; c: number; d1: import('../src/shared/leadjoy.ts').LjValue }
}
check('trigger write envelope', trigWr.c === 91 && trigWr.w.b === 1 && trigWr.w.c === 0)
const d1Trig = ljParseTriggerD1(trigWr.w.d1)
check(
  'trigger deadzones 10/95 both',
  JSON.stringify(d1Trig.dzl) === JSON.stringify([10, 95]) && JSON.stringify(d1Trig.dzr) === JSON.stringify([10, 95]) &&
    d1Trig.mol === 2 && d1Trig.mor === 2 && d1Trig.vtl === 0 && d1Trig.vtr === 0
)
check('trigger write rebuild byte-exact', hex(ljBuildTriggerWrite(0, d1Trig)) === hex(fixture('trig-wr-main.bin')))
check('trigger frame byte-exact', hex(ljFrameBytes(fixture('trig-wr-main.bin'))) === hex(fixture('trig-wr-frame.bin')))
const ack91 = [...unhex('a50bcc82a1635ba1650063'), ...new Array(64 - 11).fill(0)]
check('trigger ack parses', JSON.stringify(ljParseWriteAck(ljParseSingleFrame(ack91), 91)) === JSON.stringify({ record: 91 }))
for (const zones of [[[101, 95], [10, 95]], [[-1, 95], [10, 95]], [[5.5, 95], [10, 95]]]) {
  try {
    ljBuildTriggerWrite(0, { ...d1Trig, dzl: zones[0] as [number, number], dzr: zones[1] as [number, number] })
    check(`trigger builder refuses ${JSON.stringify(zones[0])}`, false)
  } catch {
    check(`trigger builder refuses ${JSON.stringify(zones[0])}`, true)
  }
}
check('curve validator accepts fixture', JSON.stringify(ljValidateCurveWire(d1Right.cv)) === JSON.stringify(d1Right.cv))
for (const bad of [[], new Array(15).fill(0), new Array(16).fill(32768), new Array(16).fill(-1), new Array(16).fill(1.5), 'nope', null]) {
  try {
    ljValidateCurveWire(bad)
    check(`curve validator refuses ${JSON.stringify(bad)?.slice(0, 20)}`, false)
  } catch {
    check(`curve validator refuses ${JSON.stringify(bad)?.slice(0, 20)}`, true)
  }
}

if (failures > 0) {
  console.error(`${failures} FAILURES`)
  process.exit(1)
} else console.log('ALL LEADJOY TESTS PASSED')
