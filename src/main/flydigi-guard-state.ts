/**
 * State shared by the app and the leave-in-XInput helper (a small JSON file in the app's data folder):
 * - enabled: the user setting "return the pad to XInput when I leave" (default on)
 * - armed:   the pad was last seen in DInput mode, so it still has to be put back
 * - pid:     the app process that owns the state; a helper left over from an older run stands down when it changes
 */
import { readFileSync, writeFileSync } from 'node:fs'

export interface FxGuardState {
  enabled: boolean
  armed: boolean
  pid: number
}

export function readGuardState(file: string): FxGuardState {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'))
    return { enabled: s.enabled !== false, armed: s.armed === true, pid: Number(s.pid) || 0 }
  } catch {
    return { enabled: true, armed: false, pid: 0 }
  }
}

export function writeGuardState(file: string, s: FxGuardState): void {
  try {
    writeFileSync(file, JSON.stringify(s))
  } catch {
    /* data folder not writable: the next start simply cannot fix a pad left in DInput */
  }
}
