/**
 * Entry point for the elevated copy of the raw-USB rate code: Stick Labs starts its own executable with
 * ELECTRON_RUN_AS_NODE and this script when UsbDk refuses a normal user, and reads the result file.
 * Usage: flydigi-usb-run.js --out result.json [--set-rate CODE | --read-rate | --settings 50:09:01,...] [--to-dinput]
 */
import { writeFileSync } from 'node:fs'
import { fxUsbReadRate, fxUsbSendRate, fxUsbSendSettings, fxUsbSetRate, fxUsbSwitchToDInput, runChild } from './flydigi-usb'

const arg = (n: string): string | null => (process.argv.includes(n) ? (process.argv[process.argv.indexOf(n) + 1] ?? '') : null)
const out = arg('--out')
/** "50:09:01,30:0d:00" -> [[0x50, 0x09, 1], [0x30, 0x0d, 0]] */
const frames = (spec: string): number[][] =>
  spec.split(',').filter(Boolean).map((f) => {
    const b = f.split(':').map((h) => parseInt(h, 16))
    if (b.length !== 3 || b.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) throw new Error(`flydigi: bad settings frame "${f}"`)
    return b
  })
const result: { ok: boolean; error: string | null; reportRate: number | null; status: number[] | null } = { ok: false, error: null, reportRate: null, status: null }

async function main(): Promise<void> {
  const set = arg('--set-rate')
  const toDInput = process.argv.includes('--to-dinput')
  const send = arg('--send-rate')
  const sendSettings = arg('--send-settings')
  const settings = arg('--settings')
  if (send !== null) await fxUsbSendRate(Number(send))
  else if (sendSettings !== null) await fxUsbSendSettings(frames(sendSettings))
  else if (settings !== null) {
    // send, read back, then (optionally) switch to DInput: each step in its own child, as for the rate
    frames(settings)
    const sent = await runChild(['--send-settings', settings])
    if (!sent.ok) throw new Error(sent.error ?? 'flydigi: sending the settings failed.')
    await new Promise((r) => setTimeout(r, 1500))
    const back = await runChild(['--read-rate'])
    if (!back.ok) throw new Error(back.error ?? 'flydigi: the read-back after the settings change failed.')
    result.reportRate = back.reportRate ?? null
    result.status = back.status ?? null
    if (toDInput) {
      const sw = await runChild(['--to-dinput'])
      if (!sw.ok) throw new Error(sw.error ?? 'flydigi: the switch to DInput failed after the settings were applied.')
    }
  }
  else if (set !== null) result.reportRate = await fxUsbSetRate(Number(set), toDInput)
  else {
    const read = process.argv.includes('--read-rate')
    if (read && toDInput) {
      // One open per process: UsbDk keeps the pad claimed until the process that opened it ends, so the read and the
      // switch each run in their own child and this process never opens the pad.
      const r = await runChild(['--read-rate'])
      if (!r.ok) throw new Error(r.error ?? 'flydigi: the settings read failed.')
      result.reportRate = r.reportRate ?? null
      result.status = r.status ?? null
      const sw = await runChild(['--to-dinput'])
      if (!sw.ok) throw new Error(sw.error ?? 'flydigi: the switch to DInput failed.')
    } else if (read) {
      const r = await fxUsbReadRate()
      result.reportRate = r.rate
      result.status = r.status
    } else if (toDInput) await fxUsbSwitchToDInput()
  }
  result.ok = true
}

main()
  .catch((e) => {
    result.error = (e as Error).message
  })
  .finally(() => {
    if (out) writeFileSync(out, JSON.stringify(result))
    process.exit(result.ok ? 0 : 2)
  })
