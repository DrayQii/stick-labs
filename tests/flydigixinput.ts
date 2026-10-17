/**
 * Flydigi XInput-mode config codec, checked against a real Direwolf 4 read
 * (fixtures/flydigi/fp4-cfg1.bin) and the exact frames the live write test sent.
 */
import { readFileSync } from 'node:fs'
import { AIM_CURVES } from '../src/shared/aimcurves.ts'
import {
  FX_BLOB_LEN,
  fxAssembleBlob,
  fxApplyConfig,
  fxDataVersion,
  FX_CURVE_CUSTOM,
  FX_CURVE_DEFAULT,
  FX_CURVE_DEFAULT_POINTS,
  fxCurveFromDesign,
  fxCurvePercentToRaw,
  fxCurveRawToPercent,
  fxDeadzonePoints,
  fxFromDInput,
  fxDInputSetting,
  fxXInputSettingFrame,
  fxDecodeXStatus,
  fxParseDInputLive,
  fxDecodeStatus,
  fxDInputReadStatus,
  FXD_CMD_STATUS,
  fxDInputSwitchToXInput,
  fxHzFromReportRate,
  fxToDInput,
  fxReadConfigId,
  fxWriteStart,
  fxDecodeCurves,
  fxDecodeKeys,
  fxDecodeSticks,
  fxSetKeyTarget,
  fxSetKeyTurbo,
  fxSteamWindow,
  fxSetMotion,
  fxDecodeMotion,
  FX_TURBO_CLICK,
  FX_TURBO_PRESS,
  FX_KEY_DEFAULT,
  fxDecodeTriggers,
  fxDecodeVibration,
  fxDiffPacks,
  fxEncodeVibration,
  fxParseAck,
  fxReadConfig,
  fxRunFrames,
  fxSave,
  fxSaveAcked,
  fxSetCurve,
  fxSetStickCenter,
  fxSetTrigger,
  fxTriggerRange,
  type FxAck
} from '../src/shared/flydigi-xinput.ts'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures++
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ')

const blob = new Uint8Array(readFileSync(new URL('../fixtures/flydigi/fp4-cfg1.bin', import.meta.url)))
check('fixture is 840 bytes', blob.length === FX_BLOB_LEN)
check('data version 0x080a', fxDataVersion(blob) === 0x080a)

const vib = fxDecodeVibration(blob)
check('vibration decodes (on, 60..255, scale 20)', vib.enabled && vib.left.min === 60 && vib.left.max === 255 && vib.left.scale === 20 && vib.right.scale === 20)
check('left stick centre 0x0d, end 0x7f', fxDecodeSticks(blob).left.center === 0x0d && fxDecodeSticks(blob).left.end === 0x7f)
check('vibration encode round-trips', hex(fxEncodeVibration(blob, vib)) === hex(blob))

// The exact frames of the live write test: scale 0x14 -> 0x32 on the left motor.
const edited = fxEncodeVibration(blob, { ...vib, left: { ...vib.left, scale: 0x32 } })
const runs = fxDiffPacks(blob, edited)
check('one changed pack at index 14', runs.length === 1 && runs[0].startPack === 14 && runs[0].packs.length === 1)
const frames = fxRunFrames(runs[0], 1)
check('start frame matches hardware', hex(frames[0]) === 'a5 23 0e 01 a0 01 00 00 00 00 00 00 00 00 00', hex(frames[0]))
check('pack frame matches hardware', hex(frames[1]) === 'a5 24 08 19 19 01 ff 00 00 3c ff 32 a0 00 00', hex(frames[1]))
check('save frame matches hardware', hex(fxSave(fxDataVersion(blob))) === 'a5 50 03 0a 08 00 00 00 00 00 00 00 00 00 00')
check('apply-config frame (config 2 = id 1)', hex(fxApplyConfig(1)) === 'a5 50 05 01 00 00 00 00 00 00 00 00 00 00 00')
check('read-config frame', hex(fxReadConfig(1)) === 'a5 21 01 00 00 00 00 00 00 00 00 00 00 00 00')

// Left stick centre (109 + 1 = 110) lives in pack 11.
const dz = fxDiffPacks(blob, fxSetStickCenter(blob, 0, 5))
check('stick centre change is one pack (11)', dz.length === 1 && dz[0].startPack === 11 && dz[0].packs.length === 1)

// Two separated edits -> two runs.
const two = fxDiffPacks(blob, fxSetStickCenter(fxEncodeVibration(blob, { ...vib, left: { ...vib.left, scale: 1 } }), 0, 5))
check('separate edits make separate runs', two.length === 2 && two[0].startPack === 11 && two[1].startPack === 14)

// --- stick curves (offset 790), against the real read ---
const curves = fxDecodeCurves(blob)
check('left curve: Custom, 35..150, circular', curves.left.type === FX_CURVE_CUSTOM && curves.left.points.join() === '35,49,64,78,92,106,121,135,150' && curves.left.circularity === 1)
check('right curve: Default stock ramp', curves.right.type === FX_CURVE_DEFAULT && curves.right.points.join() === FX_CURVE_DEFAULT_POINTS.join())
check('curve set round-trips', hex(fxSetCurve(fxSetCurve(blob, 0, curves.left), 1, curves.right)) === hex(blob))
const bumped = fxSetCurve(blob, 1, { ...curves.right, type: FX_CURVE_CUSTOM, points: curves.right.points.map((p) => p + 1) })
const cdiff = fxDiffPacks(blob, bumped)
// Right stick Default -> Custom changes the main record's type byte (116, pack 11) and the curve record (790..: packs 80..81).
check('right curve edit: main type byte (pack 11) + curve record (packs 80..81)', cdiff.length === 2 && cdiff[0].startPack === 11 && cdiff[0].packs.length === 1 && cdiff[1].startPack === 80 && cdiff[1].packs.length === 2, JSON.stringify(cdiff.map((r) => [r.startPack, r.packs.length])))
check('Space Station mirrors the type in both places', bumped[116] === 3 && bumped[802] === 3)
check('curve edit leaves everything else alone', bumped.slice(0, 116).every((v, i) => v === blob[i]) && bumped.slice(117, 802).every((v, i) => v === blob[117 + i]) && bumped.slice(815).every((v, i) => v === blob[815 + i]))

// Deadzone -> curve, against Space Station's logged writes (left stick, slider value -> points).
const dzObs: Record<number, number[]> = {
  0: [50, 63, 75, 88, 100, 113, 125, 138, 150],
  5: [45, 58, 71, 84, 97, 110, 123, 137, 150],
  10: [39, 53, 67, 81, 94, 108, 122, 136, 150],
  13: [35, 49, 64, 78, 92, 106, 121, 135, 150],
  20: [25, 41, 56, 72, 88, 103, 119, 134, 150],
  50: [0, 0, 0, 25, 50, 75, 100, 125, 150],
  100: [50, 50, 50, 50, 50, 50, 50, 50, 50]
}
for (const [d, want] of Object.entries(dzObs)) {
  const got = fxDeadzonePoints(Number(d))
  const maxErr = Math.max(...got.map((v, i) => Math.abs(v - want[i])))
  check(`deadzone ${d} -> curve (max error ${maxErr})`, maxErr <= 1, got.join())
}
// Space Station service log (UpdateConfig joystickConfig): [centre, edge] -> the nine points it wrote.
const ceObs: Array<[number, number, number[]]> = [
  [-100, 0, [150, 150, 150, 150, 150, 150, 150, 150, 150]],
  [-13, 0, [63, 74, 85, 96, 107, 118, 129, 139, 150]],
  [0, -30, [50, 59, 68, 76, 85, 94, 103, 111, 120]],
  [-13, -30, [63, 70, 78, 85, 92, 99, 106, 113, 120]],
  [-40, -30, [90, 94, 98, 101, 105, 109, 113, 116, 120]],
  [50, -30, [0, 0, 15, 33, 50, 68, 85, 103, 120]],
  [50, 30, [0, 0, 0, 0, 50, 113, 150, 150, 150]]
]
for (const [c, e, want] of ceObs) {
  const got = fxDeadzonePoints(c, e)
  const maxErr = Math.max(...got.map((v, i) => Math.abs(v - want[i])))
  check(`centre ${c} / edge ${e} -> curve (max error ${maxErr})`, maxErr <= 1, got.join())
}
// Turbo entries (Space Station wire bytes: A Press 8 -> 04 01 08, R3 Click 15 -> 0f 02 0f)
{
  const base = new Uint8Array(840).fill(0xff)
  const a = fxSetKeyTurbo(base, 4, { type: FX_TURBO_PRESS, frequency: 8 })
  check('turbo A press 8 writes 04 01 08', a[25] === 0x04 && a[26] === 0x01 && a[27] === 0x08)
  const r3 = fxSetKeyTurbo(base, 15, { type: FX_TURBO_CLICK, frequency: 15 })
  check('turbo R3 click 15 writes 0f 02 0f', r3[58] === 0x0f && r3[59] === 0x02 && r3[60] === 0x0f)
  const dec = fxDecodeKeys(a).find((k) => k.id === 4)!
  check('turbo entry decodes back', dec.kind === 'turbo' && dec.enableType === FX_TURBO_PRESS && dec.frequency === 8)
  check('turbo off writes the default entry', fxSetKeyTarget(a, 4, 0xff).slice(25, 28).join() === '255,0,0')
  check('turbo only touches its own entry', fxDiffPacks(base, a).reduce((n, r) => n + r.packs.length, 0) <= 2)
  let refused = false
  try {
    fxSetKeyTurbo(a, 4, { type: FX_TURBO_PRESS, frequency: 0 })
  } catch {
    refused = true
  }
  check('turbo frequency 0 is refused', refused)
}
// Gyro (Space Station log: Left stick, Racer, enable RT, Press, deadzone 8, sensitivity 46 -> 01 0d 01 08 2e 2e 01 ff)
{
  const base = new Uint8Array(840).fill(0xff)
  const m = fxSetMotion(base, { mapping: 1, enableKey: 13, enableType: 1, deadZone: 8, sensitivity: 46, racer: 1, enableKey2: 255 })
  check('gyro left/RT/press/8/46/racer writes 01 0d 01 08 2e 2e 01 ff', Array.from(m.subarray(137, 145)).map((v) => v.toString(16).padStart(2, '0')).join(' ') === '01 0d 01 08 2e 2e 01 ff')
  const d = fxDecodeMotion(m)
  check('gyro decodes back', d.mapping === 1 && d.enableKey === 13 && d.deadZone === 8 && d.sensitivity === 46 && d.sensitivityY === 46 && d.racer === 1)
  const r = fxSetMotion(m, { mapping: 2, racer: 0, sensitivity: 30, enableKey: 12, enableType: 0, deadZone: 17 })
  check('gyro right/LT/17/30 matches the final log state 02 0c 00 11 1e 1e 00 ff', Array.from(r.subarray(137, 145)).map((v) => v.toString(16).padStart(2, '0')).join(' ') === '02 0c 00 11 1e 1e 00 ff')
  check('gyro edit leaves every other byte alone', r.every((v, i) => (i >= 137 && i < 145) || v === base[i]))
}
// Steam export window: deadzone -> inner, positive edge -> outer, negative values only partly transfer
check('steam window: centre 13 / edge 0 -> inner 13, outer 100', JSON.stringify(fxSteamWindow(13, 0)) === JSON.stringify({ begin: 13, end: 100, anti: 0, edgeLost: false }))
check('steam window: edge 30 -> outer 70', fxSteamWindow(0, 30).end === 70)
check('steam window: centre -40 -> no deadzone, anti-deadzone on', fxSteamWindow(-40, 0).begin === 0 && fxSteamWindow(-40, 0).anti === 40)
check('steam window: negative edge is flagged as not transferred', fxSteamWindow(0, -30).edgeLost === true && fxSteamWindow(0, -30).end === 100)
check('steam window: clamps out-of-range input', fxSteamWindow(500, 500).begin === 100 && fxSteamWindow(500, 500).end === 0)
check('edge byte is signed: -30 -> 0xe2', ((-30) & 0xff) === 0xe2)
check('deadzone 0, 10, 20, 50, 100 are exact', [0, 10, 20, 50, 100].every((d) => fxDeadzonePoints(d).join() === dzObs[d].join()))

// --- DInput transport translation, against replies captured from the pad in 04B4:2412 mode ---
const h2 = (s: string): Uint8Array => Uint8Array.from(s.split(' ').map((x) => parseInt(x, 16)))
check('DInput read-config-id frame', hex(fxToDInput(fxReadConfigId())) === '05 eb a0 00 00 00 00 00 00 00 00 00 00 00 00')
check('DInput read-config frame', hex(fxToDInput(fxReadConfig(1))) === '05 eb 01 00 00 00 00 00 00 00 00 00 00 00 00')
check('DInput write-start frame', hex(fxToDInput(fxWriteStart(14, 1, 1))) === '05 ef 0e 01 a0 01 00 00 00 00 00 00 00 00 00')
check('DInput pack frame', hex(fxToDInput(frames[1])) === '05 22 08 19 19 01 ff 00 00 3c ff 32 a0 00 00')
check('DInput save frame', hex(fxToDInput(fxSave(0x080a))) === '05 50 03 0a 08 00 00 00 00 00 00 00 00 00 00')
const idReply = fxFromDInput(h2('04 ff f0 aa ac 00 a0 04 00 00 00 00 00 00 00 00 01 81 00 80 00 80 7e 00 00 00 00 00 84 02 00 00'))
check('DInput config-id reply: active 0 of 4', idReply.length === 1 && idReply[0].cmd === 0x20 && idReply[0].data[0] === 0 && idReply[0].data[2] === 4)
check('DInput switch-to-XInput frame', hex(fxDInputSwitchToXInput()) === '05 ed 00 00 00 00 00 00 00 00 00 00 00 00 00')
check('DInput plain input yields no ack', fxFromDInput(h2('04 fe 66 00 00 00 00 00 00 00 00 00 00 00 00 ff 00 81 00 80 00 80 7e 00 00 00 00 00 84 01 00 00')).length === 0)
check('DInput get-info reply yields no ack', fxFromDInput(h2('04 ff f0 84 00 0a 08 61 38 34 72 04 02 01 06 ec 00 81 00 80 00 80 7e 00 00 00 00 00 84 02 00 00')).length === 0)
// A pack reply for index 80 must not be mistaken for the 0x50 save ack (idx 80 = 0x50).
const p80 = fxFromDInput(h2('04 ff f0 50 00 01 02 03 04 05 06 07 08 09 0a eb 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00'))
check('pack index 80 is a config pack, not a save ack', p80.length === 1 && p80[0].cmd === 0x22 && p80[0].data[0] === 0x50 && p80[0].data[1] === 1)
// Reassemble the real DInput config read: pack 0 of a 0x0301 blob.
const dAcks: FxAck[] = []
for (let i = 0; i < 84; i++) {
  const rep = new Uint8Array(32)
  rep.set([0x04, 0xff, 0xf0, i, 0], 0)
  rep.set(blob.subarray(i * 10, i * 10 + 10), 5)
  rep[15] = 0xeb
  dAcks.push(...fxFromDInput(rep))
}
const dBlob = fxAssembleBlob(dAcks)
check('84 DInput pack replies reassemble the blob', !!dBlob && hex(dBlob) === hex(blob))

// --- triggers (offset 123) ---
const trig = fxDecodeTriggers(blob)
check('fixture triggers decode (type 0, full range)', trig.left.type === 0 && trig.left.end === 0xff && trig.right.end === 0xff && trig.left.p2x === 0xff, JSON.stringify(trig.left))
check('trigger set round-trips', hex(fxSetTrigger(fxSetTrigger(blob, 0, trig.left), 1, trig.right)) === hex(blob))
const tEdit = fxSetTrigger(blob, 0, { ...trig.left, end: 231 })
const tDiff = fxDiffPacks(blob, tEdit)
check('left trigger end 231 is one pack (12)', tDiff.length === 1 && tDiff[0].startPack === 12 && tDiff[0].packs[0][9 - 0] !== undefined, JSON.stringify(tDiff.map((r) => r.startPack)))
// Space Station's trigger writes (from its log acks): the slider values ARE the bytes.
const rec = (t: { type: number; zero: number; p1x: number; p1y: number; p2x: number; p2y: number; end: number }): string => hex(Uint8Array.of(t.type, t.zero, t.p1x, t.p1y, t.p2x, t.p2y, t.end))
check('trigger start 20 / end 255 matches Space Station', rec(fxTriggerRange(trig.left, 20, 255)) === '00 14 14 14 ff ff ff', rec(fxTriggerRange(trig.left, 20, 255)))
check('trigger start 0 / end 110 matches Space Station', rec(fxTriggerRange(trig.left, 0, 110)) === '00 00 00 00 6e 6e 6e', rec(fxTriggerRange(trig.left, 0, 110)))
check('trigger end byte lands at 129', tEdit[129] === 231 && tEdit.slice(0, 129).every((v, i) => v === blob[i]) && tEdit.slice(130).every((v, i) => v === blob[130 + i]))

// --- button remaps, against Space Station's logged writes (A -> B, then B -> A) ---
const keys0 = fxDecodeKeys(blob)
check('fixture: A and B unremapped, M1->A, M2->B', keys0.find((k) => k.id === 4)!.target === FX_KEY_DEFAULT && keys0.find((k) => k.id === 18)!.target === 4 && keys0.find((k) => k.id === 19)!.target === 5)
const aToB = fxSetKeyTarget(blob, 4, 5)
const aToBpack = fxDiffPacks(blob, aToB)
check('A->B is one pack (2) matching Space Station', aToBpack.length === 1 && aToBpack[0].startPack === 2 && hex(aToBpack[0].packs[0]) === '00 00 ff 00 00 05 00 00 ff 00', hex(aToBpack[0]?.packs[0] ?? new Uint8Array(0)))
const swapped = fxSetKeyTarget(aToB, 5, 4)
const swapPack = fxDiffPacks(blob, swapped)
check('then B->A matches Space Station', swapPack.length === 1 && hex(swapPack[0].packs[0]) === '00 00 ff 00 00 05 00 00 04 00', hex(swapPack[0].packs[0]))
check('clearing a remap restores the default entry', hex(fxSetKeyTarget(aToB, 4, FX_KEY_DEFAULT)) === hex(blob))
check('non-Direwolf key refused', (() => { try { fxSetKeyTarget(blob, 30, 4); return false } catch { return true } })())

check('report-rate codes 1/2/4/8 = 1000/500/250/125 Hz', [1, 2, 4, 8].map((c) => fxHzFromReportRate(c)).join() === '1000,500,250,125' && fxHzFromReportRate(3) === null && fxHzFromReportRate(null) === null)

// --- curve designer helpers ---
check('linear preset samples onto the stock ramp', fxCurveFromDesign(AIM_CURVES.linear.pts).join() === FX_CURVE_DEFAULT_POINTS.join(), fxCurveFromDesign(AIM_CURVES.linear.pts).join())
check('percent <-> raw: 0% = 50, 100% = 150, clamped', fxCurvePercentToRaw(0) === 50 && fxCurvePercentToRaw(100) === 150 && fxCurvePercentToRaw(-80) === 0 && fxCurveRawToPercent(150) === 100 && fxCurveRawToPercent(0) === -50)
for (const [key, c] of Object.entries(AIM_CURVES)) {
  const raw = fxCurveFromDesign(c.pts)
  check(`preset ${key}: nine points, rising, starts at 0%`, raw.length === 9 && raw[0] === 50 && raw.every((v, i) => i === 0 || v >= raw[i - 1]), raw.join())
}
check('a design that ends below 100% stays below 150', fxCurveFromDesign(AIM_CURVES.machixo.pts)[8] < 150, String(fxCurveFromDesign(AIM_CURVES.machixo.pts)[8]))

// Ack parsing / blob assembly from real reply shapes.
const rep = (cmd: number, data: number[]): Uint8Array => {
  const r = new Uint8Array(32)
  r[1] = 0x14
  r[13] = 1
  r[14] = 0xa5
  r[15] = cmd
  r.set(data, 16)
  return r
}
const acks: FxAck[] = []
for (let i = 0; i < 84; i++) {
  const data = [i, ...blob.subarray(i * 10, i * 10 + 10)]
  const a = fxParseAck(rep(0x22, data))!
  acks.push(a)
  if (i === 5) acks.push(a) // duplicate reply, as on hardware (85 replies for 84 packs)
}
const back = fxAssembleBlob(acks)
check('84 replies (+1 duplicate) reassemble the blob', !!back && hex(back) === hex(blob))
check('missing pack -> null', fxAssembleBlob(acks.filter((a) => a.data[0] !== 40)) === null)
check('plain input report is not an ack', fxParseAck(new Uint8Array(32)) === null)
const saveAck = fxParseAck(rep(0x50, [3, 1]))
check('save ack recognised', !!saveAck && fxSaveAcked(saveAck))

// DInput status read (05 F2 03): the Direwolf 4 answers the short form, captured on the pad: sleep 15 min, quick switch on.
check('status read frame is 05 F2 03', hex(fxDInputReadStatus().subarray(0, 3)) === '05 f2 03')
const st = fxFromDInput(h2('04 ff f0 f2 03 0f 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00'))
check('status reply becomes one status ack', st.length === 1 && st[0].cmd === FXD_CMD_STATUS)
const ps = fxDecodeStatus(st[0].data)
check('status decodes: sleep 15 min, quick switch on', ps.sleepMinutes === 15 && ps.quickSwitchOn)

// Live stream: the input report captured from the pad (sticks centred, triggers 0, nothing pressed).
const idle = fxParseDInputLive(h2('04 fe 66 00 00 00 00 00 00 00 00 00 00 00 00 ff 00 81 00 80 00 80 7e 00 00 00 00 00 84 01 00 00'))
check('live report: centred sticks, triggers 0, nothing pressed', !!idle && idle.lx === 0x81 && idle.ly === 0x80 && idle.rx === 0x80 && idle.ry === 0x7e && idle.lt === 0 && idle.rt === 0 && idle.pressed.length === 0)
const pressed = h2('04 fe 66 00 00 00 00 05 18 11 05 00 00 00 00 ff 00 81 00 80 00 80 7e ff 00 00 00 00 84 01 00 00')
const busy = fxParseDInputLive(pressed)
check(
  'live report: button bits and trigger',
  !!busy && busy.lt === 255 && ['C', 'M1', 'Home', 'Back', 'Up', 'A', 'Y', 'LB'].every((b) => busy.pressed.includes(b)) && busy.pressed.length === 8,
  busy?.pressed.join(',')
)
check('live report: pressed key ids (M1 = 18, Home = 27)', !!busy && busy.ids.includes(18) && busy.ids.includes(27) && busy.ids.includes(4) && busy.ids.length === 8)
check('config reply is not a live report', fxParseDInputLive(h2('04 ff f0 50 00 01 02 03 04 05 06 07 08 09 0a eb 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00')) === null)

// Pad settings: DInput setting frames (Space Station's commands) and the XInput settings block (bytes 17..27).
check('sleep frame 05 F2 02 0F', hex(fxDInputSetting('sleep', 15).subarray(0, 4)) === '05 f2 02 0f')
check('quick switch on 05 FA A2 01', hex(fxDInputSetting('quickSwitch', true).subarray(0, 4)) === '05 fa a2 01')
check('auto-calibration off 05 50 09 01', hex(fxDInputSetting('autoCalibration', false).subarray(0, 4)) === '05 50 09 01')
check('rebound on 05 50 0E 00', hex(fxDInputSetting('rebound', true).subarray(0, 4)) === '05 50 0e 00')
check('gyro debounce on 05 F5 06 00', hex(fxDInputSetting('gyroDebounce', true).subarray(0, 4)) === '05 f5 06 00')
check('XInput auto-calibration off A5 50 09 01', fxXInputSettingFrame('autoCalibration', false).join() === '80,9,1')
check('XInput stick debounce on A5 50 08 00', fxXInputSettingFrame('stickDebounce', true).join() === '80,8,0')
check('XInput rebound off A5 50 0E 01', fxXInputSettingFrame('rebound', false).join() === '80,14,1')
check('XInput gyro debounce on A5 30 0D 00', fxXInputSettingFrame('gyroDebounce', true).join() === '48,13,0')
const xs = fxDecodeXStatus([0, 1, 0, 15, 1, 1, 0, 17, 0, 0, 0])
check('XInput settings block decodes', xs.mappingSwitchOn && !xs.stickDebounceOn && xs.autoCalibrationOn && xs.sleepMinutes === 15 && xs.quickSwitchOn && xs.reportRate === 1 && xs.reboundOn)

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall flydigi xinput checks passed')
