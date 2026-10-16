/**
 * Flydigi (Apex / Vader) — identify-only wire record.
 *
 * Source: SDL's HIDAPI Flydigi driver (src/joystick/hidapi/SDL_hidapi_flydigi.c,
 * zlib-licensed), which Flydigi engineers contributed to. Only the read-only
 * handshake is used here: check-architecture (0x07), get-info (0x01) and
 * get-status (0x10). Nothing below writes pad state.
 *
 * Framing (V2, VID 0x37D7, usage page 0xFFA0):
 *   OUT: [reportId][5A][A5][cmd][args…]   reportId 0x03, or 0x00 on pads that
 *        use unnumbered reports (Vader 5 Pro 0x2401, Apex 6 0x2502).
 *   IN : 32-byte reports [5A][A5][cmd]…, sometimes with a leading report-ID
 *        byte — strip it when byte 1/2 carry the magic.
 *
 * Get-info reply (after stripping): [5] device id, [6] connection,
 * [11] battery (hi nibble status, lo nibble level), [15..16] firmware BE.
 *
 * Tuning (deadzones, curves, polling) is NOT here: Flydigi Space Station's
 * config protocol is unpublished. Writes stay locked until a capture proves
 * the framing with readback, same rule as every other pad in Stick Labs.
 */

export const FD_VID_V1 = 0x04b4
export const FD_VID_V2 = 0x37d7
export const FD_PID_V1_GAMEPAD = 0x2412
export const FD_PID_V2_APEX = 0x2501
export const FD_PID_V2_APEX6 = 0x2502
export const FD_PID_V2_VADER = 0x2401
export const FD_USAGE_PAGE = 0xffa0
/** Early (V1) pads expose their vendor protocol on interface 2 only. */
export const FD_V1_INTERFACE = 2

export const FD_CMD_REPORT_ID = 0x03
export const FD_MAGIC1 = 0x5a
export const FD_MAGIC2 = 0xa5
export const FD_CMD_GET_INFO = 0x01
export const FD_CMD_CHECK_ARCH = 0x07
export const FD_CMD_GET_STATUS = 0x10
export const FD_REPLY_LEN = 32

export interface FdHidLike {
  vendorId?: number
  productId?: number
  usagePage?: number
  interface?: number
}

/** True for a Flydigi vendor-config interface (never filters on V2 PID). */
export function isFlydigiInterface(d: FdHidLike): boolean {
  if (d.vendorId === FD_VID_V2) return d.usagePage === FD_USAGE_PAGE
  // 0x04B4 is Cypress's VID — only the one Flydigi PID on interface 2.
  if (d.vendorId === FD_VID_V1) return d.productId === FD_PID_V1_GAMEPAD && d.interface === FD_V1_INTERFACE
  return false
}

/** Vader 5 Pro and Apex 6 take unnumbered command reports. */
export function fdUsesUnnumberedReports(vendorId: number, productId: number): boolean {
  return vendorId === FD_VID_V2 && (productId === FD_PID_V2_VADER || productId === FD_PID_V2_APEX6)
}

/**
 * One command report, unpadded exactly as SDL sends it. hidapi on Windows
 * zero-pads short writes up to the interface's output report length; padding
 * here instead would overrun a shorter report and fail the write.
 */
function command(cmd: number, args: number[], unnumbered: boolean): Uint8Array {
  return new Uint8Array([unnumbered ? 0x00 : FD_CMD_REPORT_ID, FD_MAGIC1, FD_MAGIC2, cmd, ...args])
}

export const fdCheckArchitecture = (unnumbered: boolean): Uint8Array => command(FD_CMD_CHECK_ARCH, [0, 0], unnumbered)
export const fdGetInfo = (unnumbered: boolean): Uint8Array => command(FD_CMD_GET_INFO, [2, 0], unnumbered)
export const fdGetStatus = (unnumbered: boolean): Uint8Array => command(FD_CMD_GET_STATUS, [], unnumbered)

/**
 * Normalise an IN report to start at the magic; null when it is not a
 * Flydigi command reply (input frames, foreign reports, short reads).
 */
export function fdFrame(raw: Uint8Array): Uint8Array | null {
  let d = raw
  if (d.length > 2 && d[0] !== FD_MAGIC1 && d[1] === FD_MAGIC1 && d[2] === FD_MAGIC2) d = d.subarray(1)
  if (d.length < 3 || d[0] !== FD_MAGIC1 || d[1] !== FD_MAGIC2) return null
  return d
}

export type FdConnection = 'wired' | 'wireless' | 'unknown'
export type FdPower = 'battery' | 'charging' | 'charged' | 'unknown'

export interface FdInfo {
  deviceId: number
  modelName: string
  /** 16-bit firmware, e.g. 0x7141. */
  firmware: number
  firmwareText: string
  connection: FdConnection
  power: FdPower
  /** 0–100, or null when unknown. */
  batteryPercent: number | null
  newArchitecture: boolean
}

/** Device-ID → marketing name (SDL_hidapi_flydigi.c UpdateDeviceIdentity). */
const DEVICE_IDS: ReadonlyArray<[number[], string]> = [
  [[19], 'Flydigi Apex 2'],
  [[24, 26, 29], 'Flydigi Apex 3'],
  [[84], 'Flydigi Apex 4'],
  [[128, 129, 133, 134], 'Flydigi Apex 5'],
  [[149, 150, 152], 'Flydigi Apex 6'],
  [[20, 21, 23], 'Flydigi Vader 2'],
  [[22], 'Flydigi Vader 2 Pro'],
  [[28], 'Flydigi Vader 3'],
  [[80, 81], 'Flydigi Vader 3 Pro'],
  [[85, 91, 105], 'Flydigi Vader 4 Pro'],
  [[130], 'Flydigi Vader 5 Pro']
]

/** Name fallback when the device id is new (mirrors SDL's string sniffing). */
export function fdNameFromProduct(product: string | undefined): string | null {
  if (!product) return null
  const p = product.toUpperCase().replace(/\s+/g, '')
  for (const n of [2, 3, 4, 5, 6]) if (p.includes(`APEX${n}`)) return `Flydigi Apex ${n}`
  if (p.includes('VADER5')) return 'Flydigi Vader 5 Pro'
  if (p.includes('VADER4')) return 'Flydigi Vader 4 Pro'
  if (p.includes('VADER3')) return 'Flydigi Vader 3'
  if (p.includes('VADER2')) return 'Flydigi Vader 2'
  if (p.includes('DIREWOLF4')) return 'Flydigi Direwolf 4'
  if (p.includes('DIREWOLF3')) return 'Flydigi Direwolf 3'
  if (p.includes('DIREWOLF')) return 'Flydigi Direwolf'
  return null
}

export function fdModelName(deviceId: number, product?: string): string {
  for (const [ids, name] of DEVICE_IDS) if (ids.includes(deviceId)) return name
  return fdNameFromProduct(product) ?? `Flydigi (device id ${deviceId})`
}

/** True when a check-architecture reply marks the new architecture. */
export function fdIsNewArchitecture(reply: Uint8Array): boolean {
  const d = fdFrame(reply)
  return !!d && d[2] === FD_CMD_CHECK_ARCH && d[3] === 1 && d[4] === 0
}

/** Decode a get-info reply. Null when the frame is not one. */
export function fdParseInfo(reply: Uint8Array, newArchitecture: boolean, product?: string): FdInfo | null {
  const d = fdFrame(reply)
  if (!d || d[2] !== FD_CMD_GET_INFO || d.length < 17) return null
  const deviceId = d[5]
  const modelName = fdModelName(deviceId, product)
  const firmware = d[16] | (d[15] << 8)

  // Connection byte shifted meaning with the new architecture.
  const c = d[6]
  const connection: FdConnection = newArchitecture
    ? c === 0 ? 'wired' : c === 1 ? 'wireless' : 'unknown'
    : c === 1 ? 'wired' : c === 2 ? 'wireless' : 'unknown'

  const status = (d[11] >> 4) & 0x0f
  const level = d[11] & 0x0f
  // Apex 6 reports level in tenths, older pads in fifths.
  const step = modelName === 'Flydigi Apex 6' ? 10 : 20
  let power: FdPower = 'unknown'
  let batteryPercent: number | null = null
  if (status === 0 || status === 1) {
    power = status === 0 ? 'battery' : 'charging'
    batteryPercent = Math.min(100, level * step)
  } else if (status === 2) {
    power = 'charged'
    batteryPercent = 100
  }

  return {
    deviceId,
    modelName,
    firmware,
    firmwareText: `0x${firmware.toString(16).padStart(4, '0').toUpperCase()}`,
    connection,
    power,
    batteryPercent,
    newArchitecture
  }
}

/**
 * Get-status reply: byte 9 = 1 when third-party apps may take the pad over.
 * False means "Allow third-party apps to take over mappings" is off in Space Station.
 */
export function fdParseThirdPartyAllowed(reply: Uint8Array): boolean | null {
  const d = fdFrame(reply)
  if (!d || d[2] !== FD_CMD_GET_STATUS || d.length < 10) return null
  return d[9] === 1
}

// ---------------------------------------------------------------------------
// V1 (VID 0x04B4 PID 0x2412, interface 2) — older pads and the Direwolf 4 in
// DInput mode. Space Station's log shows it sending exactly this on MI_02:
// "WriteData 0xEC: 05-EC-00-00-00-00-00-00-00-00-00-00-00-00-00".
// Reply (SDL InitControllerV1): 32 bytes, [15] = 0xEC, [3] device id,
// [5..8] serial, [9..10] firmware LE, [13] 0 wireless / 1 wired (fw ≥ 0x6400).
// ---------------------------------------------------------------------------

export const FD_V1_CMD_REPORT_ID = 0x05
export const FD_V1_CMD_GET_INFO = 0xec

/** V1 get-info, byte-identical to Space Station's 15-byte write. */
export const fdV1GetInfo = (): Uint8Array => {
  const out = new Uint8Array(15)
  out[0] = FD_V1_CMD_REPORT_ID
  out[1] = FD_V1_CMD_GET_INFO
  return out
}

export interface FdV1Info {
  deviceId: number
  modelName: string
  firmware: number
  firmwareText: string
  serial: string
  connection: FdConnection
  power: FdPower
  /** 0-100, or null when the reply carries no usable level. */
  batteryPercent: number | null
  /** The whole 32-byte reply as hex, kept so the battery byte can be located from real captures. */
  rawHex: string
}

/** Decode a V1 get-info reply; null when the frame is not one. */
export function fdParseV1Info(reply: Uint8Array, product?: string): FdV1Info | null {
  if (reply.length < 32 || reply[15] !== FD_V1_CMD_GET_INFO) return null
  const deviceId = reply[3]
  const firmware = reply[9] | (reply[10] << 8)
  const serial = Array.from(reply.subarray(5, 9), (b) => b.toString(16).padStart(2, '0')).join('')
  let connection: FdConnection = 'unknown'
  if (firmware >= 0x6400) connection = reply[13] === 0 ? 'wireless' : reply[13] === 1 ? 'wired' : 'unknown'
  // Byte 11 matches the V2 layout (hi nibble status, lo nibble level in fifths). Read off a Direwolf 4:
  // 0x04 on battery and wired-idle, 0x14 while charging; the level scale is not yet confirmed at the extremes.
  const status = (reply[11] >> 4) & 0x0f
  const level = reply[11] & 0x0f
  let power: FdPower = 'unknown'
  let batteryPercent: number | null = null
  if (status === 0 || status === 1) {
    power = status === 0 ? 'battery' : 'charging'
    batteryPercent = Math.min(100, level * 20)
  } else if (status === 2) {
    power = 'charged'
    batteryPercent = 100
  }
  return {
    deviceId,
    modelName: fdModelName(deviceId, product),
    firmware,
    firmwareText: `0x${firmware.toString(16).padStart(4, '0').toUpperCase()}`,
    serial,
    connection,
    power,
    batteryPercent,
    rawHex: Array.from(reply.subarray(0, 32), (b) => b.toString(16).padStart(2, '0')).join(' ')
  }
}

/** Result of the identify handshake, as returned over IPC. */
export interface FdIdentifyResult {
  /** V2 get-info reply; null on V1 pads or when the pad did not answer. */
  info: FdInfo | null
  /** V1 get-info reply (04B4:2412); null on V2 pads or no answer. */
  v1: FdV1Info | null
  /** Name from the info reply, else the USB product string. */
  modelName: string
  /** Space Station's "allow third-party apps" toggle; null when unknown. */
  thirdPartyAllowed: boolean | null
  vendorId: number
  productId: number
}
