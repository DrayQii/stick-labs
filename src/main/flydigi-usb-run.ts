/**
 * Entry point for the elevated copy of the raw-USB rate code: Stick Labs starts its own executable with
 * ELECTRON_RUN_AS_NODE and this script when UsbDk refuses a normal user, and reads the result file.
 * Usage: flydigi-usb-run.js --out result.json [--set-rate CODE | --read-rate] [--to-dinput]
 */
import { writeFileSync } from 'node:fs'
import { fxUsbReadRate, fxUsbSendRate, fxUsbSetRate, fxUsbSwitchToDInput, runChild } from './flydigi-usb'

const arg = (n: string): string | null => (process.argv.includes(n) ? (process.argv[process.argv.indexOf(n) + 1] ?? '') : null)
const out = arg('--out')
const result: { ok: boolean; error: string | null; reportRate: number | null; status: number[] | null } = { ok: false, error: null, reportRate: null, status: null }

async function main(): Promise<void> {
  const set = arg('--set-rate')
  const toDInput = process.argv.includes('--to-dinput')
  const send = arg('--send-rate')
  if (send !== null) await fxUsbSendRate(Number(send))
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
