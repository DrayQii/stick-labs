/**
 * "Return the pad to XInput when I leave" for the Direwolf 4 (setting, default on). Stick Labs needs the pad in
 * DInput mode, which the pad remembers across replugs, so without this a user who closes the app is left with a pad
 * games do not see as an Xbox controller. Covered exits:
 * - quit (tray Quit, updater, Windows closing the app): switch before exiting, wait for the pad to leave DInput
 * - Windows ending the session or going to sleep: switch at once
 * - crash or the process being killed: flydigi-guard.js (started detached once the pad is seen in DInput) notices
 *   the app is gone and switches the pad
 * - pad unplugged when the app quits: the helper waits up to 30 min for it; failing that, the next start switches it
 * In-app disconnects call the same switch from the renderer (flydigix:toXInput).
 */
import { app, powerMonitor } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { readGuardState, writeGuardState, type FxGuardState } from './flydigi-guard-state'
import { fxPadMode, fxSendToXInput, fxSendToXInputNow } from './flydigi-switch'

let stateFile = ''
let state: FxGuardState = { enabled: true, armed: false, pid: 0 }
let guardStarted = false
let watch: NodeJS.Timeout | null = null

function save(next: Partial<FxGuardState>): void {
  const merged = { ...state, ...next }
  if (merged.enabled === state.enabled && merged.armed === state.armed && merged.pid === state.pid) return
  state = merged
  writeGuardState(stateFile, state)
}

function startGuard(): void {
  if (guardStarted) return
  const script = join(__dirname, 'flydigi-guard.js')
  if (!existsSync(script)) return
  try {
    const c = spawn(process.execPath, [script, '--launch', '--parent', String(process.pid), '--state', stateFile], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    c.unref()
    guardStarted = true
  } catch {
    /* no crash cover this run; quit and next start still switch the pad */
  }
}

/** Track the pad's mode: seen in DInput = armed (and make sure the helper runs), seen in XInput = nothing to do. */
export function fxLeaveNoteMode(mode: 'dinput' | 'xinput' | 'none'): void {
  if (!stateFile) return
  if (mode === 'dinput') {
    save({ armed: true })
    if (state.enabled) startGuard()
  } else if (mode === 'xinput') save({ armed: false })
}

/** Call once the app is ready, before the window: fixes a pad an earlier run could not put back, starts tracking. */
export async function fxLeaveInit(): Promise<void> {
  stateFile = join(app.getPath('userData'), 'flydigi-leave-xinput.json')
  const prev = readGuardState(stateFile)
  state = { ...prev, pid: process.pid }
  writeGuardState(stateFile, state)
  if (state.enabled && prev.armed && fxPadMode() === 'dinput') {
    if (await fxSendToXInput()) save({ armed: false })
  }
  watch = setInterval(() => fxLeaveNoteMode(fxPadMode()), 3000)
  powerMonitor.on('suspend', () => fxLeaveNow())
}

/** No time to wait (session ending, sleep): send the switch and move on. */
export function fxLeaveNow(): void {
  if (!state.enabled || !stateFile) return
  if (fxSendToXInputNow()) save({ armed: false })
}

/** On quit: switch the pad if it is in DInput mode and wait for it (the helper covers an unplugged pad). */
export async function fxLeaveOnQuit(): Promise<void> {
  if (watch) clearInterval(watch)
  if (!state.enabled || !stateFile) return
  const mode = fxPadMode()
  if (mode === 'dinput') {
    if (await fxSendToXInput()) save({ armed: false })
  } else if (mode === 'xinput') save({ armed: false })
}

export function fxLeaveEnabled(): boolean {
  return state.enabled
}

export function fxLeaveSetEnabled(on: boolean): boolean {
  save({ enabled: on })
  if (on && state.armed) startGuard()
  return state.enabled
}
