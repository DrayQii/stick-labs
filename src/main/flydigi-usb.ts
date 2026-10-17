/**
 * Direwolf 4 in XInput mode (045E:028E) over raw USB, without Space Station or Python.
 *
 * Uses node-usb's libusb (1.0.30) with the UsbDk backend: UsbDk lends the pad to this process while it is open and
 * hands it back to the Xbox driver afterwards, so no driver is replaced. libusb is initialised when `usb` loads and
 * `useUsbDkBackend()` then sets the option on that context, which is the order libusb 1.0.30 needs.
 *
 * The frames are the same as the Space Station helper's (docs/flydigi.md): 15-byte `A5 <cmd> ...` interrupt writes to
 * the first OUT endpoint, replies are 32-byte reports from the first IN endpoint (`A5 50 07` at [14..16], rate at [22]).
 * Codes: 1 = 1000 Hz, 2 = 500, 4 = 250, 8 = 125. The pad re-enumerates to apply a new rate.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const FX_USB_VID = 0x045e
export const FX_USB_PID = 0x028e

/** Run one USB step; a failure says which step it was (libusb's own text is only an error name). */
function step<T>(what: string, fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    const err = e as Error & { errno?: number }
    const wrapped = new Error(`${what}: ${err.message}${err.errno !== undefined ? ` (errno ${err.errno})` : ''}`)
    wrapped.name = err.name
    throw wrapped
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** The access errors a non-elevated process gets from UsbDk; the caller retries elevated. */
export class FxUsbAccessError extends Error {}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type UsbLib = any
let lib: UsbLib | null = null

function load(): UsbLib {
  if (lib) return lib
  try {
    lib = createRequire(__filename)('usb')
  } catch (e) {
    throw new Error(`flydigi: the USB library could not be loaded (${(e as Error).message})`)
  }
  if (process.env.FLYDIGI_USB_DEBUG) lib.usb.setDebugLevel(4) // libusb's own log on stderr
  try {
    lib.useUsbDkBackend()
  } catch {
    throw new Error('flydigi: UsbDk is not available. Install UsbDk (github.com/daynix/UsbDk/releases), then try again.')
  }
  return lib
}

interface Pad {
  dev: any // eslint-disable-line @typescript-eslint/no-explicit-any
  inEp: any // eslint-disable-line @typescript-eslint/no-explicit-any
  outEp: any // eslint-disable-line @typescript-eslint/no-explicit-any
  iface: any // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function openPad(waitMs: number): Promise<Pad> {
  const usb = load()
  const end = Date.now() + waitMs
  for (;;) {
    const dev = step('listing USB devices', () => usb.findByIds(FX_USB_VID, FX_USB_PID))
    if (dev) {
      try {
        step('opening the pad', () => dev.open())
        const iface = dev.interfaces.find((i: any) => i.endpoints.some((e: any) => e.transferType === 3)) // eslint-disable-line @typescript-eslint/no-explicit-any
        if (!iface) throw new Error('flydigi: the pad has no interrupt endpoints; this is not the expected XInput layout.')
        step('claiming the interface', () => iface.claim())
        const eps = iface.endpoints.filter((e: any) => e.transferType === 3) // eslint-disable-line @typescript-eslint/no-explicit-any
        const inEp = eps.find((e: any) => e.direction === 'in') // eslint-disable-line @typescript-eslint/no-explicit-any
        const outEp = eps.find((e: any) => e.direction === 'out') // eslint-disable-line @typescript-eslint/no-explicit-any
        if (!inEp || !outEp) throw new Error('flydigi: the pad has no interrupt IN/OUT endpoint pair.')
        inEp.timeout = 100
        outEp.timeout = 2000
        return { dev, inEp, outEp, iface }
      } catch (e) {
        try { dev.close() } catch { /* not open */ }
        const msg = (e as Error).message ?? ''
        // UsbDk's StartRedirect reports a refusal as LIBUSB_ERROR_OTHER on open: no administrator rights, or another
        // program has the pad open for a moment (a device scan). Retry until the deadline, then give up.
        if (/opening the pad|ACCESS|NOT_SUPPORTED|BUSY/i.test(msg) && Date.now() < end) {
          await sleep(500)
          continue
        }
        if (/opening the pad|ACCESS|NOT_SUPPORTED|BUSY/i.test(msg)) {
          throw new FxUsbAccessError(`flydigi: UsbDk could not open the pad (${msg}). It needs administrator rights, and Space Station, the Xbox app and games must not hold the pad.`)
        }
        throw e
      }
    }
    if (Date.now() > end) throw new Error('flydigi: the pad (045E:028E) is not visible through UsbDk. Is it wired and in XInput mode (FN + D-pad Right)?')
    await sleep(250)
  }
}

function closePad(p: Pad): void {
  try { p.iface.release(true, () => undefined) } catch { /* gone */ }
  try { p.dev.close() } catch { /* gone */ }
}

const readOnce = (p: Pad): Promise<Buffer | null> =>
  new Promise((resolve, reject) => {
    p.inEp.transfer(64, (err: Error & { errno?: number }, data?: Buffer) => {
      if (err) err.message = `reading from the pad: ${err.message} (errno ${err.errno})`
      if (!err) return resolve(data ?? null)
      if (/TIMED_OUT|TIMEOUT/i.test(err.message) || err.errno === 2 || err.errno === -7) return resolve(null)
      reject(err)
    })
  })

const write = (p: Pad, cmd: number, ...args: number[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const frame = Buffer.alloc(15)
    frame[0] = 0xa5
    frame[1] = cmd
    args.forEach((a, i) => (frame[2 + i] = a))
    p.outEp.transfer(frame, (err?: Error) => (err ? reject(new Error(`flydigi: writing to the pad failed (${err.message}, errno ${(err as Error & { errno?: number }).errno})`)) : resolve()))
  })

/** The settings reply: rate code (byte 22) and the pad settings block (bytes 17..27, docs/flydigi.md). */
interface RateRead {
  rate: number
  status: number[]
}

async function readRate(p: Pad): Promise<RateRead> {
  // The pad streams input non-stop; skip what is queued, but never wait for it to run dry.
  for (const end = Date.now() + 400; Date.now() < end; ) if (!(await readOnce(p).catch(() => null))) break
  await write(p, 0x50, 0x07)
  for (const end = Date.now() + 3000; Date.now() < end; ) {
    const d = await readOnce(p)
    if (d && d.length >= 28 && d[14] === 0xa5 && d[15] === 0x50 && d[16] === 0x07) return { rate: d[22], status: Array.from(d.subarray(17, 28)) }
  }
  throw new Error('flydigi: the pad did not answer the settings read.')
}

/**
 * Read the stored polling-rate code and the pad settings block. Right after a mode switch or a rate change the pad is still re-enumerating and
 * its endpoints answer with transfer errors, so a failed attempt is retried with a fresh open for up to ~15 s.
 */
export async function fxUsbReadRate(): Promise<RateRead> {
  let last: Error = new Error('flydigi: the pad did not answer the settings read.')
  for (const end = Date.now() + 15000; Date.now() < end; ) {
    let p: Pad | null = null
    try {
      p = await openPad(Math.max(1000, end - Date.now()))
      return await readRate(p)
    } catch (e) {
      if (e instanceof FxUsbAccessError) throw e
      last = e as Error
    } finally {
      if (p) closePad(p)
    }
    await sleep(1500)
  }
  throw last
}

/** Send the rate frame only (no read-back). A transfer error is expected: the pad drops off USB to apply it. */
export async function fxUsbSendRate(code: number): Promise<void> {
  if (![1, 2, 4, 8].includes(code)) throw new Error('flydigi: polling-rate code must be 1, 2, 4 or 8')
  const p = await openPad(12000)
  try {
    await write(p, 0x50, 0x0a, code).catch(() => undefined)
  } finally {
    closePad(p)
  }
}

/** Run flydigi-usb-run.js in its own process (this executable as node) and return what it wrote. */
export async function runChild(args: string[]): Promise<{ ok: boolean; error?: string; reportRate?: number | null }> {
  const out = join(tmpdir(), `flydigi-usb-child-${Date.now()}.json`)
  // the bundler may inline this file into the runner (same folder) or put it in chunks/ (one level down)
  const script = [join(__dirname, 'flydigi-usb-run.js'), join(__dirname, '..', 'flydigi-usb-run.js')].find((f) => existsSync(f)) ?? join(__dirname, 'flydigi-usb-run.js')
  const done = await new Promise<number>((resolve) => {
    const c = spawn(process.execPath, [script, ...args, '--out', out], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: 'ignore' })
    c.on('error', () => resolve(-1))
    c.on('exit', (n) => resolve(n ?? -1))
  })
  try {
    const r = JSON.parse(readFileSync(out, 'utf8'))
    rmSync(out, { force: true })
    return r
  } catch {
    return { ok: false, error: `flydigi: a USB step did not run (exit ${done}).` }
  }
}

/**
 * Set the polling-rate code and read it back. UsbDk keeps the pad claimed for as long as the process that opened it
 * lives, and the pad re-enumerates to apply a rate, so each step runs in its own short-lived process and this one
 * never opens the pad: send the frame, wait for the pad to come back, then read (and optionally switch to DInput).
 */
export async function fxUsbSetRate(code: number, toDInput: boolean): Promise<number> {
  if (![1, 2, 4, 8].includes(code)) throw new Error('flydigi: polling-rate code must be 1, 2, 4 or 8')
  const sent = await runChild(['--send-rate', String(code)])
  if (!sent.ok) throw new Error(sent.error ?? 'flydigi: sending the rate failed.')
  await sleep(4000)
  const back = await runChild(['--read-rate'])
  if (!back.ok) throw new Error(back.error ?? 'flydigi: the read-back after the rate change failed.')
  if (back.reportRate !== code) throw new Error(`flydigi: the pad reports polling-rate code ${back.reportRate} after setting ${code}`)
  if (toDInput) {
    const sw = await runChild(['--to-dinput'])
    if (!sw.ok) throw new Error(sw.error ?? 'flydigi: the switch to DInput failed after the rate was applied.')
  }
  return code
}

/** XInput -> DInput (legacy frame A5 17). */
export async function fxUsbSwitchToDInput(): Promise<void> {
  const p = await openPad(12000)
  try {
    await write(p, 0x17)
    await sleep(2000)
  } finally {
    closePad(p)
  }
}
