/**
 * Flydigi XInput-mode config codec, checked against a real Direwolf 4 read
 * (fixtures/flydigi/fp4-cfg1.bin) and the exact frames the live write test sent.
 */
import { readFileSync } from 'node:fs'
import {
  FX_BLOB_LEN,
  fxAssembleBlob,
  fxDataVersion,
  fxDecodeSticks,
  fxDecodeVibration,
  fxDiffPacks,
  fxEncodeVibration,
  fxParseAck,
  fxReadConfig,
  fxRunFrames,
  fxSave,
  fxSaveAcked,
  fxSetStickCenter,
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
check('read-config frame', hex(fxReadConfig(1)) === 'a5 21 01 00 00 00 00 00 00 00 00 00 00 00 00')

// Left stick centre (109 + 1 = 110) lives in pack 11.
const dz = fxDiffPacks(blob, fxSetStickCenter(blob, 0, 5))
check('stick centre change is one pack (11)', dz.length === 1 && dz[0].startPack === 11 && dz[0].packs.length === 1)

// Two separated edits -> two runs.
const two = fxDiffPacks(blob, fxSetStickCenter(fxEncodeVibration(blob, { ...vib, left: { ...vib.left, scale: 1 } }), 0, 5))
check('separate edits make separate runs', two.length === 2 && two[0].startPack === 11 && two[1].startPack === 14)

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

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall flydigi xinput checks passed')
