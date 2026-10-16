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

/** One command report, padded to report-ID + 32 bytes (Windows wants the full length). */
function command(cmd: number, args: number[], unnumbered: boolean): Uint8Array {
  const out = new Uint8Array(1 + FD_REPLY_LEN)
  out.set([unnumbered ? 0x00 : FD_CMD_REPORT_ID, FD_MAGIC1, FD_MAGIC2, cmd, ...args])
  return out
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

/** Result of the identify handshake, as returned over IPC. */
export interface FdIdentifyResult {
  /** Null on V1 pads (no V2 handshake) or when the pad did not answer. */
  info: FdInfo | null
  /** Name from the info reply, else the USB product string. */
  modelName: string
  /** Space Station's "allow third-party apps" toggle; null when unknown. */
  thirdPartyAllowed: boolean | null
  vendorId: number
  productId: number
}
