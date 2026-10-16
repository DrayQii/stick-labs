export interface Candidate {
  path: string
  productId: number
  preferred: boolean
  product: string | undefined
  manufacturer: string | undefined
  live: boolean | null
}
import type { DeepPollResult } from '@shared/deeppoll'
import type { LjButtonTarget, LjSnapshot, LjStickPatch } from '@shared/leadjoy'
import type { FdIdentifyResult } from '@shared/flydigi'
import type { FxSnapshot, FxPatch } from '@shared/flydigi-xinput'
export interface DeviceInfo {
  firmware: string
  dongle: string
  currentProfile: number
}
export interface DeviceStats {
  inputFrames: number
  responses: number
  rateHz: number
  live: boolean
}
export interface PingResult {
  count: number
  samples: number[]
  min: number
  max: number
  median: number
  mean: number
}
export interface LiveSample {
  lx: number
  ly: number
  rx: number
  ry: number
  lt: number
  rt: number
  calTarget: number
  calMask: number
  battery: number
  live: boolean
  timestamp: number
}

interface LabApi {
  discover(): Promise<Candidate[]>
  connect(path: string): Promise<DeviceInfo>
  disconnect(): Promise<boolean>
  readProfile(profile: number, total?: number): Promise<{ bytes: string; length: number }>
  writeProfile(profile: number, dataB64: string, length?: number): Promise<{ verified: boolean; rolledBack: boolean }>
  switchProfile(profile: number): Promise<boolean>
  currentProfile(): Promise<number>
  calibration(state: number): Promise<boolean>
  setStickCenter(stick: number, direction: number): Promise<boolean>
  ping(count: number): Promise<PingResult>
  openExternal(url: string): Promise<boolean>
  version(): Promise<string>
  steamInfo(): Promise<{ steamPath: string | null; userId: string | null; apexInstalled: boolean; apexAppId: number; steamRunning: boolean }>
  steamExport(
    left: { begin: number; end: number },
    right: { begin: number; end: number },
    mouseRate?: number | null,
    curveExp?: number | null
  ): Promise<{ game: string; appId: number; files: string[]; backedUp: string[]; mapped: string[]; notTransferred: string[] }>
  steamGames(): Promise<Array<{ appId: number; name: string }>>
  steamExportAll(
    left: { begin: number; end: number },
    right: { begin: number; end: number },
    mouseRate?: number | null,
    curveExp?: number | null
  ): Promise<{ games: Array<{ appId: number; name: string }>; result: { games: Array<{ appId: number; name: string; ok: boolean; detail: string }> } }>
  /** MARIUS board — read-only preview scaffold. No write path exists. */
  /** Kernel USB poll check (elevated ETW trace, UAC prompts once per run). */
  deeppoll(vid: number, pid: number, seconds?: number): Promise<DeepPollResult>
  /** Flydigi: read-only identify handshake (model, firmware, connection, battery). */
  flydigiIdentify(path: string): Promise<FdIdentifyResult>
  /** Flydigi Direwolf 4 (DInput mode, plain HID): read a config slot. Space Station must be closed. */
  flydigiXRead(cfgId?: number): Promise<FxSnapshot>
  /** Make a config slot (0-based) the one the pad runs. */
  flydigiXActivate(cfgId: number): Promise<FxSnapshot>
  /** Verified write (rolled back on mismatch); `save` persists across replug. */
  flydigiXWrite(patch: FxPatch): Promise<{ verified: boolean; restored: boolean; saved: boolean; changedPacks: number }>
  /** LeadJoy Saber Plus: read-only Main-slot snapshot (sticks stay locked). */
  leadjoyReadMain(path: string): Promise<LjSnapshot>
  /** LeadJoy slot snapshot (Main 0 / Sub1 1 / Sub2 2). */
  leadjoyReadSlot(req: { path: string; slot: number }): Promise<LjSnapshot>
  /** LeadJoy button remap (verified write; stock, gamepad, keyboard or mouse target). */
  leadjoyWriteButton(req: { path: string; slot: number; id: number; target: LjButtonTarget | null }): Promise<{ verified: boolean; restored: boolean }>
  /** LeadJoy stick image write (verified read-modify-write of a validated patch). */
  leadjoyWriteStick(req: { path: string; slot: number; side: number; patch: LjStickPatch }): Promise<{ verified: boolean; restored: boolean }>
  /** LeadJoy trigger deadzone write (verified write, ints 0..100). */
  leadjoyWriteTrigger(req: { path: string; slot: number; zones: { leftInner: number; leftOuter: number; rightInner: number; rightOuter: number } }): Promise<{ verified: boolean; restored: boolean }>
  on(channel: string, fn: (payload: never) => void): () => void
}

declare global {
  interface Window {
    sticklab: LabApi
  }
}

export function api(): LabApi {
  if (!window.sticklab) throw new Error('sticklab bridge unavailable')
  return window.sticklab
}

export function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
export function bytesToB64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}
