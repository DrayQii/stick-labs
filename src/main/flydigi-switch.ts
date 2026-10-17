/**
 * Direwolf 4 mode detection and the DInput -> XInput switch (05 ED) over plain HID, with no Electron imports so the
 * leave-in-XInput helper (flydigi-guard.ts, run as plain node) can use it too.
 */
import HIDModule from 'node-hid'
import { fxDInputSwitchToXInput } from '../shared/flydigi-xinput'

const FD_V1_VID = 0x04b4
const FD_V1_PID = 0x2412
const FD_V1_INTERFACE = 2

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Path of the DInput vendor interface, or null when the pad is not in DInput mode. */
export function fxDinputPath(): string | null {
  try {
    const d = HIDModule.devices().find((x) => x.vendorId === FD_V1_VID && x.productId === FD_V1_PID && x.interface === FD_V1_INTERFACE)
    return d?.path ?? null
  } catch {
    return null
  }
}

/** A Direwolf 4 in XInput mode (Xbox 360 identity, serial FLYDIGI_DIREWOLF_4). */
export function fxXInputPresent(): boolean {
  try {
    return HIDModule.devices().some((d) => d.vendorId === 0x045e && d.productId === 0x028e && /DIREWOLF_4/i.test(d.serialNumber ?? ''))
  } catch {
    return false
  }
}

let scansPaused = false
let lastMode: 'dinput' | 'xinput' | 'none' = 'none'

/**
 * Pause the background mode checks (listing HID devices opens each one briefly, which can make UsbDk's take-over of
 * the pad fail). While paused, fxPadMode returns the last mode seen.
 */
export function fxPauseScans(on: boolean): void {
  scansPaused = on
}

/** Which mode the Direwolf is in right now (the last one seen while scans are paused). */
export function fxPadMode(): 'dinput' | 'xinput' | 'none' {
  if (scansPaused) return lastMode
  lastMode = fxDinputPath() ? 'dinput' : fxXInputPresent() ? 'xinput' : 'none'
  return lastMode
}

/**
 * Write 05 ED to the vendor interface on a fresh handle and return at once (no waiting), for moments with no time
 * to wait (Windows ending the session). False when the pad is not in DInput mode or the write failed.
 */
export function fxSendToXInputNow(): boolean {
  const path = fxDinputPath()
  if (!path) return false
  try {
    const h = new HIDModule.HID(path)
    try {
      h.write(Array.from(fxDInputSwitchToXInput()))
    } finally {
      h.close()
    }
    return true
  } catch {
    return false
  }
}

/** Send 05 ED and wait (up to `waitMs`) for the pad to leave DInput mode. */
export async function fxSendToXInput(waitMs = 6000): Promise<boolean> {
  if (!fxSendToXInputNow()) return false
  for (const end = Date.now() + waitMs; Date.now() < end; ) {
    if (!fxDinputPath()) return true
    await sleep(250)
  }
  return !fxDinputPath()
}
