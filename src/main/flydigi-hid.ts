/**
 * Flydigi Direwolf 4 config session over plain HID: read, verified write, save.
 *
 * The pad must be in DInput mode (USB 04B4:2412); its vendor interface (2,
 * usage page 0xFFA0) takes Space Station's DInput commands (report 0x05) and
 * answers with `04 FF F0 …` reports. No driver, no Space Station, no admin.
 * Every write is read back; a mismatch is rolled back to the config captured
 * just before the write. Framing: src/shared/flydigi-xinput.ts, docs/flydigi.md.
 *
 * The one exception: if the pad is in XInput mode, "Read pad" first switches it to
 * DInput by launching scripts/flydigi-xinput-helper.py elevated (UAC prompt). The same helper
 * sets/reads the polling rate, which the pad only exposes in XInput mode. That helper is the
 * only thing that touches Space Station's filter driver.
 */
import { app } from 'electron'
import HIDModule, { type HID as HIDInstance } from 'node-hid'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FX_BLOB_LEN,
  FX_KEY_DEFAULT,
  FX_CMD_READ_CFG_ACK,
  FX_CMD_READ_CFG_ID,
  FX_CMD_SAVE,
  FX_CMD_WRITE_PACK,
  FX_CMD_WRITE_START,
  fxApplyConfig,
  fxAssembleBlob,
  fxCfgCountFromAck,
  fxCfgIdFromAck,
  fxDataVersion,
  fxDecodeCurves,
  fxDecodeKeys,
  fxDecodeMotion,
  fxDecodeSticks,
  fxDecodeTriggers,
  fxDecodeVibration,
  fxDInputSwitchToXInput,
  fxDiffPacks,
  fxEncodeVibration,
  fxFromDInput,
  fxReadConfig,
  fxReadConfigId,
  fxRunFrames,
  fxSave,
  fxSaveAcked,
  fxSetCurve,
  fxSetKeyTarget,
  fxSetKeyTurbo,
  fxSetMotion,
  fxSetStickCenter,
  fxSetTrigger,
  fxToDInput,
  type FxAck,
  type FxPatch,
  type FxSnapshot
} from '../shared/flydigi-xinput'

const FD_V1_VID = 0x04b4
const FD_V1_PID = 0x2412
const FD_V1_INTERFACE = 2
const ACK_TIMEOUT_MS = 2000
const READ_SETTLE_MS = 2500

let hid: HIDInstance | null = null
let acks: FxAck[] = []
let busy = Promise.resolve()

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Path of the DInput vendor interface, or null when the pad is not in DInput mode. */
function dinputPath(): string | null {
  try {
    const d = HIDModule.devices().find((x) => x.vendorId === FD_V1_VID && x.productId === FD_V1_PID && x.interface === FD_V1_INTERFACE)
    return d?.path ?? null
  } catch {
    return null
  }
}

/** Open (or reuse) the vendor interface; re-opens after a replug or mode change. */
function open(): void {
  const path = dinputPath()
  if (!path) {
    close()
    throw new Error('flydigi: Direwolf 4 not found in DInput mode (USB 04B4:2412). Close Flydigi Space Station (it switches the pad back to XInput) and check the pad is in DInput mode — see docs/flydigi.md.')
  }
  if (hid) return
  try {
    const h = new HIDModule.HID(path)
    h.on('data', (raw: Buffer) => {
      for (const a of fxFromDInput(new Uint8Array(raw))) acks.push(a)
    })
    h.on('error', () => {
      if (hid === h) hid = null
    })
    hid = h
  } catch (e) {
    throw new Error(`flydigi: cannot open the DInput interface (${(e as Error).message}). Close Flydigi Space Station and retry.`)
  }
}

/** A Direwolf 4 in XInput mode (Xbox 360 identity, serial FLYDIGI_DIREWOLF_4). */
function xinputDirewolfPresent(): boolean {
  try {
    return HIDModule.devices().some((d) => d.vendorId === 0x045e && d.productId === 0x028e && /DIREWOLF_4/i.test(d.serialNumber ?? ''))
  } catch {
    return false
  }
}

/** Which mode the Direwolf is in right now: 'dinput' (04B4:2412 vendor interface), 'xinput', or 'none'. */
export function fxHidMode(): 'dinput' | 'xinput' | 'none' {
  if (dinputPath()) return 'dinput'
  return xinputDirewolfPresent() ? 'xinput' : 'none'
}

function spaceStationRunning(): boolean {
  try {
    const r = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
    return /SpaceStationService\.exe|Flydigi Space Station\.exe/i.test(r.stdout ?? '')
  } catch {
    return false
  }
}

const psq = (v: string): string => `'${v.replace(/'/g, "''")}'`

/**
 * Run a helper script from scripts/ and return its result. The default helper talks to Space
 * Station's filter driver, so the pad must be in XInput mode and Space Station closed. `elevate`
 * runs it through a UAC prompt; without it the script is spawned as the current user, and exit
 * code 3 (access denied) comes back as `denied` so the caller can retry elevated.
 */
async function runHelper(
  args: string[],
  opts: { script?: string; elevate?: boolean } = {}
): Promise<{ reportRate: number | null; denied?: boolean }> {
  const { script: name = 'flydigi-xinput-helper.py', elevate = true } = opts
  if (spaceStationRunning()) {
    throw new Error('flydigi: Flydigi Space Station (or its background service) is running. Close it fully, then try again.')
  }
  const script = join(__dirname, '../../scripts', name)
  const out = join(tmpdir(), `flydigi-helper-${Date.now()}.json`)
  const py = process.env.FLYDIGI_PYTHON ?? 'python'
  const full = [script, '--out', out, ...args]
  const code = await new Promise<number>((resolve) => {
    const c = elevate
      ? spawn(
          'powershell',
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$p = Start-Process -FilePath ${psq(py)} -ArgumentList @(${full.map((a) => psq(`"${a}"`)).join(', ')}) -Verb RunAs -WindowStyle Hidden -PassThru -Wait; exit $p.ExitCode`
          ],
          { windowsHide: true }
        )
      : spawn(py, full, { windowsHide: true })
    c.on('error', () => resolve(-1))
    c.on('exit', (n) => resolve(n ?? -1))
  })
  let parsed: { ok: boolean; error?: string; reportRate?: number | null } | null = null
  try {
    if (existsSync(out)) {
      parsed = JSON.parse(readFileSync(out, 'utf8'))
      rmSync(out, { force: true })
    }
  } catch {
    /* fall through to the generic messages */
  }
  if (!elevate && code === 3) return { reportRate: null, denied: true }
  if (parsed && !parsed.ok) throw new Error(`flydigi: ${parsed.error ?? 'the helper reported a failure'}`)
  if (code !== 0 || !parsed) {
    throw new Error('flydigi: the helper did not run — the Windows permission prompt was declined, or python could not be started (set FLYDIGI_PYTHON).')
  }
  return { reportRate: parsed.reportRate ?? null }
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(250)
  }
  return cond()
}

/**
 * Experimental, opt-in with FLYDIGI_USBDK=1: send the switch frame as a raw USB transfer through
 * UsbDk (scripts/flydigi-usbdk-switch.py). Runs as the current user first and only asks for
 * elevation if UsbDk refuses. Returns whether the pad re-enumerated as 04B4:2412.
 */
async function switchViaUsbDk(): Promise<boolean> {
  const extra = (process.env.FLYDIGI_USBDK_ARGS ?? '').split(/\s+/).filter(Boolean)
  const script = { script: 'flydigi-usbdk-switch.py' }
  try {
    let r = await runHelper(extra, { ...script, elevate: false })
    if (r.denied) r = await runHelper(extra, { ...script, elevate: true })
  } catch (e) {
    console.warn(`flydigi: UsbDk switch failed, falling back to Space Station's driver (${(e as Error).message})`)
    return false
  }
  if (await waitFor(() => dinputPath() !== null, 12000)) return true
  console.warn("flydigi: the UsbDk transfer was accepted but the pad did not switch, falling back to Space Station's driver")
  return false
}

/** Switch an XInput-mode Direwolf to DInput (UsbDk if opted in, else the elevated helper), then wait for 04B4:2412. */
async function switchToDInput(): Promise<void> {
  if (process.env.FLYDIGI_USBDK === '1' && (await switchViaUsbDk())) return
  await runHelper(['--to-dinput'])
  if (!(await waitFor(() => dinputPath() !== null, 12000))) {
    throw new Error('flydigi: the switch was sent but the pad did not appear as 04B4:2412. Unplug and replug it and try again.')
  }
}

/** Open the vendor interface, switching the pad into DInput mode first if it is in XInput mode. */
async function ensureOpen(): Promise<void> {
  if (dinputPath() === null && xinputDirewolfPresent()) await switchToDInput()
  open()
}

function close(): void {
  try {
    hid?.removeAllListeners()
    hid?.close()
  } catch {
    /* already gone */
  }
  hid = null
}

async function sendFrame(frame: Uint8Array): Promise<void> {
  try {
    hid!.write(Array.from(fxToDInput(frame)))
  } catch (e) {
    close()
    throw new Error(`flydigi: write failed (${(e as Error).message})`)
  }
}

/** Wait for an ack of `cmd` (optionally matching `pred`); returns the last such ack. */
async function waitAck(cmd: number, pred: (a: FxAck) => boolean = () => true, ms = ACK_TIMEOUT_MS): Promise<FxAck | null> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = acks.filter((a) => a.cmd === cmd && pred(a))
    if (hit.length > 0) {
      await sleep(120) // let a duplicate reply land so it cannot leak into the next wait
      return acks.filter((a) => a.cmd === cmd && pred(a)).pop() ?? null
    }
    await sleep(15)
  }
  return null
}

async function readBlob(want?: number): Promise<{ cfgId: number; activeCfgId: number; cfgCount: number; blob: Uint8Array }> {
  acks = []
  await sendFrame(fxReadConfigId())
  const idAck = await waitAck(FX_CMD_READ_CFG_ID)
  if (!idAck) throw new Error('flydigi: no reply to read-config-id (is the pad in DInput mode?)')
  const activeCfgId = fxCfgIdFromAck(idAck)
  const cfgCount = fxCfgCountFromAck(idAck)
  const cfgId = want ?? activeCfgId
  if (cfgId >= Math.max(cfgCount, 1)) throw new Error(`flydigi: the pad has ${cfgCount} configs (0..${cfgCount - 1}), asked for ${cfgId}`)
  acks = []
  await sendFrame(fxReadConfig(cfgId))
  await sleep(READ_SETTLE_MS)
  const blob = fxAssembleBlob(acks.filter((a) => a.cmd === FX_CMD_READ_CFG_ACK))
  if (!blob) throw new Error('flydigi: incomplete config read; try again')
  return { cfgId, activeCfgId, cfgCount, blob }
}

async function writeBlob(cfgId: number, from: Uint8Array, to: Uint8Array): Promise<void> {
  for (const run of fxDiffPacks(from, to)) {
    const frames = fxRunFrames(run, cfgId)
    acks = []
    await sendFrame(frames[0])
    if (!(await waitAck(FX_CMD_WRITE_START))) throw new Error('flydigi: no ack for write start')
    for (const f of frames.slice(1)) {
      acks = []
      await sendFrame(f)
      if (!(await waitAck(FX_CMD_WRITE_PACK))) throw new Error('flydigi: no ack for config pack')
    }
  }
}

function snapshot(cfgId: number, activeCfgId: number, cfgCount: number, blob: Uint8Array): FxSnapshot {
  return { cfgId, activeCfgId, cfgCount, dataVersion: fxDataVersion(blob), vibration: fxDecodeVibration(blob), sticks: fxDecodeSticks(blob), curves: fxDecodeCurves(blob), triggers: fxDecodeTriggers(blob), keys: fxDecodeKeys(blob), motion: fxDecodeMotion(blob) }
}

/** Serialise sessions: the pad answers one command at a time. */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = busy.then(fn, fn)
  busy = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

export function fxHidRead(cfgId?: number): Promise<FxSnapshot> {
  return exclusive(async () => {
    await ensureOpen()
    const r = await readBlob(cfgId)
    return snapshot(r.cfgId, r.activeCfgId, r.cfgCount, r.blob)
  })
}

/** Make a config slot the one the pad runs, then read it back to confirm. */
export function fxHidActivate(cfgId: number): Promise<FxSnapshot> {
  return exclusive(async () => {
    await ensureOpen()
    const before = await readBlob(cfgId)
    if (before.activeCfgId !== cfgId) {
      acks = []
      await sendFrame(fxApplyConfig(cfgId))
      if (!(await waitAck(FX_CMD_SAVE, (a) => a.data[0] === 5))) throw new Error('flydigi: no ack for apply-config')
    }
    const after = await readBlob(cfgId)
    if (after.activeCfgId !== cfgId) throw new Error(`flydigi: the pad still reports config ${after.activeCfgId + 1} active`)
    return snapshot(after.cfgId, after.activeCfgId, after.cfgCount, after.blob)
  })
}

const backupDir = (): string => join(app.getPath('userData'), 'flydigi-backups')
const BACKUP_NAME = /^fp4-cfg([0-7])-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d+Z)\.bin$/

/** Save a config blob to userData/flydigi-backups; returns the file name, or null if it could not be written. */
function backupBlob(cfgId: number, blob: Uint8Array): string | null {
  try {
    const dir = backupDir()
    mkdirSync(dir, { recursive: true })
    const name = `fp4-cfg${cfgId}-${new Date().toISOString().replace(/[:.]/g, '-')}.bin`
    writeFileSync(join(dir, name), blob)
    return name
  } catch {
    return null // a failed backup must not block a write the rollback still covers
  }
}

export interface FxBackup {
  name: string
  cfgId: number
  /** ISO time the backup was taken. */
  time: string
}

/** Backups on disk, newest first. */
export function fxHidBackups(): FxBackup[] {
  let names: string[] = []
  try {
    names = readdirSync(backupDir())
  } catch {
    return []
  }
  const out: FxBackup[] = []
  for (const name of names) {
    const m = BACKUP_NAME.exec(name)
    if (m) out.push({ name, cfgId: Number(m[1]), time: m[2].replace(/T(\d\d)-(\d\d)-(\d\d)-(\d+)Z$/, 'T$1:$2:$3.$4Z') })
  }
  return out.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0))
}

/** Read a config slot (the active one when omitted) and save it as a backup file. */
export function fxHidBackup(cfgId?: number): Promise<FxBackup> {
  return exclusive(async () => {
    await ensureOpen()
    const r = await readBlob(cfgId)
    const name = backupBlob(r.cfgId, r.blob)
    if (!name) throw new Error('flydigi: could not write the backup file')
    return fxHidBackups().find((b) => b.name === name)!
  })
}

/**
 * Write `want` over `before` in slot `cfgId`, read it back, roll back on a mismatch, and (when asked,
 * and the slot is the active one) save to the pad.
 */
async function commit(
  cfgId: number,
  activeCfgId: number,
  before: Uint8Array,
  want: Uint8Array,
  save: boolean | undefined
): Promise<{ verified: boolean; restored: boolean; saved: boolean; changedPacks: number }> {
  const changedPacks = fxDiffPacks(before, want).reduce((n, r) => n + r.packs.length, 0)
  if (changedPacks === 0) return { verified: true, restored: false, saved: false, changedPacks }

  await writeBlob(cfgId, before, want)
  const { blob: after } = await readBlob(cfgId)
  const verified = after.length === want.length && after.every((v, i) => v === want[i])
  if (!verified) {
    // Roll the changed packs back to what was there before and re-check.
    let restored = false
    try {
      await writeBlob(cfgId, after, before)
      const { blob: again } = await readBlob(cfgId)
      restored = again.every((v, i) => v === before[i])
    } catch {
      /* report below */
    }
    return { verified: false, restored, saved: false, changedPacks }
  }

  let saved = false
  // 0x50 03 saves the pad's current config; saving a non-active slot is not proven, so skip it.
  if (save && cfgId === activeCfgId) {
    acks = []
    await sendFrame(fxSave(fxDataVersion(after)))
    const a = await waitAck(FX_CMD_SAVE, (x) => x.data[0] === 3, 12000)
    saved = !!a && fxSaveAcked(a)
  }
  return { verified: true, restored: false, saved, changedPacks }
}

export function fxHidWrite(patch: FxPatch): Promise<{ verified: boolean; restored: boolean; saved: boolean; changedPacks: number }> {
  return exclusive(async () => {
    await ensureOpen()
    const { cfgId, activeCfgId, blob: before } = await readBlob(patch.cfgId)
    backupBlob(cfgId, before)

    let want = before
    if (patch.vibration) want = fxEncodeVibration(want, patch.vibration)
    if (patch.leftCenter !== undefined) want = fxSetStickCenter(want, 0, patch.leftCenter)
    if (patch.rightCenter !== undefined) want = fxSetStickCenter(want, 1, patch.rightCenter)
    if (patch.leftCurve) want = fxSetCurve(want, 0, patch.leftCurve)
    if (patch.rightCurve) want = fxSetCurve(want, 1, patch.rightCurve)
    for (const [id, target] of Object.entries(patch.keys ?? {})) want = fxSetKeyTarget(want, Number(id), target)
    if (patch.motion) want = fxSetMotion(want, patch.motion)
    for (const [id, t] of Object.entries(patch.turbo ?? {})) want = t ? fxSetKeyTurbo(want, Number(id), t) : fxSetKeyTarget(want, Number(id), FX_KEY_DEFAULT)
    if (patch.leftTrigger) want = fxSetTrigger(want, 0, patch.leftTrigger)
    if (patch.rightTrigger) want = fxSetTrigger(want, 1, patch.rightTrigger)
    return commit(cfgId, activeCfgId, before, want, patch.save)
  })
}

/**
 * Write a backup file back to the slot it was taken from. The slot's current contents are backed up
 * first, so a restore can itself be undone. Only files from the backup folder are accepted.
 */
export function fxHidRestore(name: string, save: boolean): Promise<{ verified: boolean; restored: boolean; saved: boolean; changedPacks: number; cfgId: number }> {
  return exclusive(async () => {
    const m = BACKUP_NAME.exec(name)
    if (!m) throw new Error('flydigi: not a backup file name')
    const cfgId = Number(m[1])
    const want = new Uint8Array(readFileSync(join(backupDir(), name)))
    if (want.length !== FX_BLOB_LEN) throw new Error(`flydigi: backup is ${want.length} bytes, expected ${FX_BLOB_LEN}`)
    await ensureOpen()
    const { activeCfgId, cfgCount, blob: before } = await readBlob(cfgId)
    if (cfgId >= Math.max(cfgCount, 1)) throw new Error(`flydigi: the pad has no config ${cfgId + 1}`)
    if (fxDataVersion(want) !== fxDataVersion(before)) throw new Error('flydigi: the backup is from a different config data version than the pad; not restoring it')
    backupBlob(cfgId, before)
    return { ...(await commit(cfgId, activeCfgId, before, want, save)), cfgId }
  })
}

/**
 * Send Space Station's SwitchToXInput (05 ED) and wait for the pad to leave
 * DInput mode. The pad drops off the bus and returns as 045E:028E, after which
 * Stick Labs can no longer configure it until it is put back in DInput mode.
 */
/** Send 05 ED over the open vendor interface and wait for the pad to leave DInput mode. */
async function hidSwitchToXInput(): Promise<boolean> {
  open()
  try {
    hid!.write(Array.from(fxDInputSwitchToXInput()))
  } catch (e) {
    close()
    throw new Error(`flydigi: write failed (${(e as Error).message})`)
  }
  const gone = await waitFor(() => dinputPath() === null, 6000)
  if (gone) close()
  return gone
}

export function fxHidSwitchToXInput(): Promise<{ switched: boolean }> {
  return exclusive(async () => ({ switched: await hidSwitchToXInput() }))
}

/**
 * Read (code = null) or set the polling rate. The Direwolf only exposes it in XInput mode, so a
 * pad in DInput mode is switched to XInput (05 ED), the elevated helper sets/reads the rate through
 * the filter driver and switches the pad back (A5 17), and this waits for 04B4:2412 to return.
 * Codes: 1 = 1000 Hz, 2 = 500, 4 = 250, 8 = 125.
 */
export function fxHidPollingRate(code: number | null): Promise<{ reportRate: number | null; verified: boolean }> {
  return exclusive(async () => {
    const wasDInput = dinputPath() !== null
    if (!wasDInput && !xinputDirewolfPresent()) throw new Error('flydigi: Direwolf 4 not found (plug it in via USB).')
    if (wasDInput) {
      if (!(await hidSwitchToXInput())) throw new Error('flydigi: the pad did not leave DInput mode; unplug and replug it and try again.')
      if (!(await waitFor(() => xinputDirewolfPresent(), 10000))) throw new Error('flydigi: the pad did not come back as an Xbox controller in time.')
    }
    const args = [...(code === null ? ['--read-rate'] : ['--set-rate', String(code)]), ...(wasDInput ? ['--to-dinput'] : [])]
    const r = await runHelper(args)
    if (wasDInput && !(await waitFor(() => dinputPath() !== null, 12000))) {
      throw new Error('flydigi: the rate was applied but the pad did not return to DInput mode. Press Read pad to switch it again.')
    }
    return { reportRate: r.reportRate, verified: code === null ? r.reportRate !== null : r.reportRate === code }
  })
}

export function fxHidStop(): void {
  close()
}
