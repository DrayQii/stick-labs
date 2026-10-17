/**
 * Experiment: does the Direwolf 4 change its real report rate in DInput mode when sent the polling-rate command
 * over plain HID?
 *
 * Background (docs/flydigi.md): in XInput mode the rate is set with `A5 50 0A <code>` through Space Station's
 * filter driver. Over plain HID (DInput, 04B4:2412) `05 50 0A <code>` is never acked and the pad has no way to
 * read the rate back, so it was never measured whether it takes effect. This script measures it: it counts the
 * input reports the pad sends per second while you move the sticks, once without any command and then after each
 * rate code (8 = 125 Hz, 4 = 250, 2 = 500, 1 = 1000).
 *
 * Needs the pad wired and in DInput mode, Flydigi Space Station closed, and `node-hid` (npm install). Run from the
 * repository root:  node scripts/flydigi-rate-probe.mjs [--seconds 4] [--codes 8,4,2,1] [--final 1]
 * Keep BOTH sticks moving in circles during every measurement (the pad only sends reports when something changes).
 * It finishes by sending `--final` (default 1 = 1000 Hz). Send nothing with `--measure-only`.
 */
import HID from 'node-hid'

const VID = 0x04b4
const PID = 0x2412
const arg = (name, def) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : def)
const SECONDS = Math.max(2, Number(arg('--seconds', '4')))
const CODES = arg('--codes', '8,4,2,1').split(',').map((s) => Number(s.trim()))
const FINAL = Number(arg('--final', '1'))
const MEASURE_ONLY = process.argv.includes('--measure-only')
const HZ = { 1: 1000, 2: 500, 4: 250, 8: 125 }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

for (const c of [...CODES, FINAL]) {
  if (!(c in HZ)) {
    console.error(`rate code ${c} is not one of 1, 2, 4, 8`)
    process.exit(2)
  }
}

const devs = HID.devices().filter((d) => d.vendorId === VID && d.productId === PID)
if (devs.length === 0) {
  console.error('No 04B4:2412 found. Put the pad in DInput mode (FN + D-pad Left), plug it in by USB, and close Space Station.')
  process.exit(2)
}
console.log('Interfaces of 04B4:2412:')
for (const d of devs) console.log(`  interface ${d.interface}  usagePage 0x${(d.usagePage ?? 0).toString(16)}  usage 0x${(d.usage ?? 0).toString(16)}`)

const vendor = devs.find((d) => d.interface === 2) ?? devs.find((d) => d.usagePage === 0xffa0)
const pads = devs.filter((d) => d.usagePage === 0x01 && (d.usage === 0x05 || d.usage === 0x04))
if (!vendor) {
  console.error('The vendor interface (interface 2) was not found.')
  process.exit(2)
}
if (pads.length === 0) {
  console.error('No gamepad input interface (usage page 0x01) found to measure.')
  process.exit(2)
}

/** Count input reports for `seconds`; returns the average per second and the best 0.5 s window scaled to one second. */
async function measure(label) {
  let h
  try {
    h = new HID.HID(pads[0].path)
  } catch (e) {
    console.error(`cannot open the gamepad interface for reading (${e.message}). Close games and other tools that read the pad.`)
    process.exit(2)
  }
  const stamps = []
  h.on('data', () => stamps.push(Date.now()))
  h.on('error', () => undefined)
  await sleep(300)
  stamps.length = 0
  const start = Date.now()
  await sleep(SECONDS * 1000)
  h.removeAllListeners()
  h.close()
  const n = stamps.length
  const avg = n / SECONDS
  let best = 0
  for (let i = 0, j = 0; i < n; i++) {
    while (stamps[i] - stamps[j] > 500) j++
    best = Math.max(best, i - j + 1)
  }
  console.log(`  ${label}: ${n} reports in ${((Date.now() - start) / 1000).toFixed(1)} s, average ${avg.toFixed(0)}/s, best half-second ${(best * 2).toFixed(0)}/s`)
  return { avg, peak: best * 2 }
}

function sendRate(code) {
  const frame = new Array(15).fill(0)
  frame[0] = 0x05
  frame[1] = 0x50
  frame[2] = 0x0a
  frame[3] = code
  const h = new HID.HID(vendor.path)
  try {
    h.write(frame)
  } finally {
    h.close()
  }
}

console.log(`\nKeep BOTH sticks moving in circles during every measurement (${SECONDS} s each). Starting in 3 s...`)
await sleep(3000)
const rows = []
console.log('\nBaseline (no command sent):')
rows.push({ code: 'baseline', ...(await measure('baseline')) })
if (!MEASURE_ONLY) {
  for (const code of CODES) {
    console.log(`\nSending 05 50 0A ${code.toString(16).padStart(2, '0')} (${HZ[code]} Hz) ...`)
    sendRate(code)
    await sleep(800)
    rows.push({ code, ...(await measure(`after code ${code} (${HZ[code]} Hz)`)) })
  }
  console.log(`\nRestoring: sending code ${FINAL} (${HZ[FINAL]} Hz).`)
  sendRate(FINAL)
}

console.log('\nSummary (reports per second, best half-second window):')
for (const r of rows) console.log(`  ${String(r.code).padEnd(9)} ${r.peak.toFixed(0).padStart(5)}`)
console.log('\nIf the numbers follow 125 / 250 / 500 / 1000 the command works over plain HID, so no driver is needed.')
console.log('If they all stay about the same, the pad ignores it here and only the XInput route (or raw USB) can set the rate.')
process.exit(0)
