/**
 * Flydigi identify handshake: command bytes, reply parsing, interface match.
 *
 * Frames are built from SDL's HIDAPI Flydigi driver layout
 * (SDL_hidapi_flydigi.c), not from hardware captures — replace them with
 * real dumps in fixtures/flydigi/ once a pad is on the bench.
 */
import {
  FD_CMD_CHECK_ARCH,
  FD_CMD_GET_INFO,
  FD_CMD_GET_STATUS,
  fdCheckArchitecture,
  fdFrame,
  fdGetInfo,
  fdGetStatus,
  fdIsNewArchitecture,
  fdModelName,
  fdParseInfo,
  fdParseThirdPartyAllowed,
  fdUsesUnnumberedReports,
  fdNameFromProduct,
  fdParseV1Info,
  fdV1GetInfo,
  isFlydigiInterface
} from '../src/shared/flydigi.ts'
import { identifyModel } from '../src/shared/models.ts'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures++
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ')

/** A 32-byte reply; `withId` prepends a report-ID byte like some pads do. */
function reply(cmd: number, set: Record<number, number>, withId = false): Uint8Array {
  const d = new Uint8Array(32)
  d[0] = 0x5a
  d[1] = 0xa5
  d[2] = cmd
  for (const [k, v] of Object.entries(set)) d[Number(k)] = v
  if (!withId) return d
  const out = new Uint8Array(33)
  out[0] = 0x03
  out.set(d, 1)
  return out
}

// --- commands (SDL byte-for-byte, unpadded: hidapi pads to the report length) ---
const info = fdGetInfo(false)
check('get-info bytes', hex(info.subarray(0, 6)) === '03 5a a5 01 02 00', hex(info.subarray(0, 6)))
check('commands are unpadded (SDL lengths)', info.length === 6 && fdGetStatus(false).length === 4)
check('check-arch bytes', hex(fdCheckArchitecture(false).subarray(0, 6)) === '03 5a a5 07 00 00')
check('get-status bytes', hex(fdGetStatus(false).subarray(0, 4)) === '03 5a a5 10')
check('unnumbered pads zero the report ID', fdGetInfo(true)[0] === 0x00 && fdGetInfo(true)[1] === 0x5a)
check('Vader 5 Pro / Apex 6 are unnumbered', fdUsesUnnumberedReports(0x37d7, 0x2401) && fdUsesUnnumberedReports(0x37d7, 0x2502))
check('Apex 5 PID uses report ID 0x03', !fdUsesUnnumberedReports(0x37d7, 0x2501))

// --- framing ---
check('frame strips leading report ID', fdFrame(reply(FD_CMD_GET_INFO, {}, true))?.[0] === 0x5a)
check('non-Flydigi frame rejected', fdFrame(new Uint8Array([0x12, 0x00, 0x00, 0x00])) === null)

// --- architecture ---
check('new architecture: [3]=1 [4]=0', fdIsNewArchitecture(reply(FD_CMD_CHECK_ARCH, { 3: 1, 4: 0 })))
check('old architecture otherwise', !fdIsNewArchitecture(reply(FD_CMD_CHECK_ARCH, { 3: 0 })))

// --- info reply ---
// Vader 5 Pro (id 130), new arch, wireless, charging at level 3, fw 0x7141.
const v5 = fdParseInfo(reply(FD_CMD_GET_INFO, { 5: 130, 6: 1, 11: 0x13, 15: 0x71, 16: 0x41 }, true), true)
check('Vader 5 Pro named', v5?.modelName === 'Flydigi Vader 5 Pro', v5?.modelName)
check('firmware big-endian [15..16]', v5?.firmware === 0x7141 && v5?.firmwareText === '0x7141', v5?.firmwareText)
check('new-arch connection 1 = wireless', v5?.connection === 'wireless')
check('charging, level 3 × 20 = 60%', v5?.power === 'charging' && v5?.batteryPercent === 60, `${v5?.power} ${v5?.batteryPercent}`)

// Apex 6 (id 150), old arch, wired, on battery level 7 → tenths.
const a6 = fdParseInfo(reply(FD_CMD_GET_INFO, { 5: 150, 6: 1, 11: 0x07, 15: 0x80, 16: 0x02 }), false)
check('Apex 6 named', a6?.modelName === 'Flydigi Apex 6')
check('old-arch connection 1 = wired', a6?.connection === 'wired')
check('Apex 6 battery in tenths (70%)', a6?.batteryPercent === 70, String(a6?.batteryPercent))

const full = fdParseInfo(reply(FD_CMD_GET_INFO, { 5: 128, 11: 0x20 }), true)
check('Apex 5 named, status 2 = charged 100%', full?.modelName === 'Flydigi Apex 5' && full?.power === 'charged' && full?.batteryPercent === 100)
check('info parser rejects other commands', fdParseInfo(reply(FD_CMD_GET_STATUS, {}), true) === null)
check('unknown id falls back to product string', fdModelName(250, 'Flydigi APEX5 Wireless') === 'Flydigi Apex 5')
check('unknown id + unknown name stays honest', fdModelName(250) === 'Flydigi (device id 250)')

// --- status ---
check('third-party takeover allowed', fdParseThirdPartyAllowed(reply(FD_CMD_GET_STATUS, { 9: 1 })) === true)
check('third-party takeover off', fdParseThirdPartyAllowed(reply(FD_CMD_GET_STATUS, { 9: 0 })) === false)

// --- interface match (never PID-filter V2) ---
check('V2 vendor page matched', isFlydigiInterface({ vendorId: 0x37d7, productId: 0x9999, usagePage: 0xffa0 }))
check('V2 gamepad page not matched', !isFlydigiInterface({ vendorId: 0x37d7, productId: 0x2501, usagePage: 0x01 }))
check('V1 only on interface 2', isFlydigiInterface({ vendorId: 0x04b4, productId: 0x2412, interface: 2 }) && !isFlydigiInterface({ vendorId: 0x04b4, productId: 0x2412, interface: 0 }))
check('other Cypress devices ignored', !isFlydigiInterface({ vendorId: 0x04b4, productId: 0x1234, interface: 2 }))

// --- V1 (04B4:2412 / Direwolf 4 in DInput mode) ---
check('V1 get-info matches Space Station write', hex(fdV1GetInfo()) === '05 ec 00 00 00 00 00 00 00 00 00 00 00 00 00', hex(fdV1GetInfo()))
const v1r = new Uint8Array(32)
v1r[3] = 19; v1r.set([0x17, 0x21, 0x39, 0x38], 5); v1r[9] = 0x10; v1r[10] = 0x64; v1r[13] = 1; v1r[15] = 0xec
const v1 = fdParseV1Info(v1r)
check('V1 reply decoded (id, serial, fw LE, wired)', v1?.deviceId === 19 && v1?.serial === '17213938' && v1?.firmware === 0x6410 && v1?.connection === 'wired', JSON.stringify(v1))
const dw = new Uint8Array(32); dw[15] = 0xec; dw[11] = 0x04
check('V1 byte 11 on battery: level 4 = 80%', fdParseV1Info(dw)?.batteryPercent === 80 && fdParseV1Info(dw)?.power === 'battery')
dw[11] = 0x14
check('V1 byte 11 charging', fdParseV1Info(dw)?.power === 'charging' && fdParseV1Info(dw)?.batteryPercent === 80)
dw[11] = 0x25
check('V1 byte 11 charged = 100%', fdParseV1Info(dw)?.batteryPercent === 100)
dw[11] = 0x75
check('V1 unknown status gives no battery', fdParseV1Info(dw)?.batteryPercent === null)
check('V1 id 19 is Apex 2', v1?.modelName === 'Flydigi Apex 2')
const old = new Uint8Array(v1r); old[10] = 0x60
check('V1 fw < 0x6400 leaves connection unknown', fdParseV1Info(old)?.connection === 'unknown')
check('V1 parser needs [15] = 0xEC', fdParseV1Info(new Uint8Array(32)) === null)
check('Direwolf 4 named from product string', fdNameFromProduct('Flydigi Direwolf 4') === 'Flydigi Direwolf 4')

// --- registry ---
check('Apex PID → FlydigiApex (detect-only)', identifyModel(undefined, 0x2501)?.id === 'FlydigiApex' && identifyModel(undefined, 0x2501)?.support === 'detect-only')
check('Vader PID → FlydigiVader', identifyModel(undefined, 0x2401)?.id === 'FlydigiVader')
check('04B4:2412 → FlydigiV1', identifyModel(undefined, 0x2412)?.id === 'FlydigiV1')
check('GameSir PIDs unaffected', identifyModel(undefined, 0x10c5)?.id === 'G7ProCE')

if (failures > 0) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nall flydigi checks passed')
