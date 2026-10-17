/**
 * Entry point for the elevated copy of the raw-USB rate code: Stick Labs starts its own executable with
 * ELECTRON_RUN_AS_NODE and this script when UsbDk refuses a normal user, and reads the result file.
 * Usage: flydigi-usb-run.js --out result.json [--set-rate CODE | --read-rate] [--to-dinput]
 */
import { writeFileSync } from 'node:fs'
import { fxUsbReadRate, fxUsbSetRate, fxUsbSwitchToDInput } from './flydigi-usb'

const arg = (n: string): string | null => (process.argv.includes(n) ? (process.argv[process.argv.indexOf(n) + 1] ?? '') : null)
const out = arg('--out')
const result: { ok: boolean; error: string | null; reportRate: number | null } = { ok: false, error: null, reportRate: null }

async function main(): Promise<void> {
  const set = arg('--set-rate')
  const toDInput = process.argv.includes('--to-dinput')
  if (set !== null) result.reportRate = await fxUsbSetRate(Number(set), toDInput)
  else {
    if (process.argv.includes('--read-rate')) result.reportRate = await fxUsbReadRate()
    if (toDInput) await fxUsbSwitchToDInput()
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
