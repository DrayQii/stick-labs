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
  /** Self-update state pushed from the main process (no dialogs anywhere). */
  updateStatus(): Promise<{ state: 'idle' | 'checking' | 'downloading' | 'ready' | 'current' | 'error'; version?: string; percent?: number; message?: string }>
  updateCheck(): Promise<boolean>
  updateInstall(): Promise<boolean>
  steamInfo(): Promise<{ steamPath: string | null; userId: string | null; apexInstalled: boolean; apexAppId: number; steamRunning: boolean }>
  steamExport(
    left: { begin: number; end: number },
    right: { begin: number; end: number },
    mouseRate?: number | null,
    curveExp?: number | null
  ): Promise<{ game: string; appId: number; files: string[]; backedUp: string[]; mapped: string[]; notTransferred: string[] }>
  steamGames(): Promise<Array<{ appId: number; name: string }>>
  /** Export stick windows to the chosen games' Steam Input configs only (Steam must be closed). */
  steamExportSelected(
    left: { begin: number; end: number; anti?: number },
    right: { begin: number; end: number; anti?: number },
    appIds: number[],
    curveExp?: number | null
  ): Promise<{ result: { games: Array<{ appId: number; name: string; ok: boolean; detail: string }> } }>
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
  /** Flydigi Direwolf 4 (DInput mode, plain HID): read a config slot. A pad in XInput mode is only switched through Space Station's driver when `viaDriver` is true. */
  flydigiXRead(cfgId?: number, viaDriver?: boolean): Promise<FxSnapshot>
  /** Polling rate (code 1/2/4/8 = 1000/500/250/125 Hz; null = just read it). Switches the pad to XInput and back via the elevated helper. */
  flydigiXRate(code: number | null): Promise<{ reportRate: number | null; verified: boolean }>
  /** Which mode the Direwolf is in right now (cheap; no traffic to the pad). */
  flydigiXMode(): Promise<'dinput' | 'xinput' | 'none'>
  /** Switch the pad from DInput back to XInput mode; it drops off the bus and returns as an Xbox 360 pad. */
  flydigiXToXInput(): Promise<{ switched: boolean }>
  /** Make a config slot (0-based) the one the pad runs. */
  flydigiXActivate(cfgId: number): Promise<FxSnapshot>
  /** Verified write (rolled back on mismatch); `save` persists across replug. */
  flydigiXWrite(patch: FxPatch): Promise<{ verified: boolean; restored: boolean; saved: boolean; changedPacks: number }>
  /** Config backups saved in userData/flydigi-backups, newest first (made before every write, or on demand). */
  flydigiXBackups(): Promise<{ name: string; cfgId: number; time: string }[]>
  /** Back up a config slot (the active one when omitted). */
  flydigiXBackup(cfgId?: number): Promise<{ name: string; cfgId: number; time: string }>
  /** Write a backup back to the slot it came from (verified, rolled back on mismatch; current contents are backed up first). */
  flydigiXRestore(name: string, save: boolean): Promise<{ verified: boolean; restored: boolean; saved: boolean; changedPacks: number; cfgId: number }>
  /** LeadJoy Saber Plus: read the complete Main-slot snapshot. */
  leadjoyReadMain(path: string): Promise<LjSnapshot>
  /** LeadJoy slot snapshot (Main 0 / Sub1 1 / Sub2 2). */
  leadjoyReadSlot(req: { path: string; slot: number }): Promise<LjSnapshot>
  /** LeadJoy button remap (verified write; stock, gamepad, keyboard or mouse target). */
  leadjoyWriteButton(req: { path: string; slot: number; id: number; target: LjButtonTarget | null }): Promise<{ verified: boolean; restored: boolean }>
  /** LeadJoy stick image write (verified read-modify-write of a validated patch). */
  leadjoyWriteStick(req: { path: string; slot: number; side: number; patch: LjStickPatch }): Promise<{ verified: boolean; restored: boolean }>
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
