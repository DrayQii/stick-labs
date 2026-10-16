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
 * DInput by launching scripts/flydigi-switch-to-dinput.py elevated (UAC prompt).
 * That helper is the only thing that touches Space Station's filter driver.
 */
import { app } from 'electron'
import HIDModule, { type HID as HIDInstance } from 'node-hid'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
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

/** Switch an XInput-mode Direwolf to DInput via the elevated helper, then wait for 04B4:2412. */
async function switchToDInput(): Promise<void> {
  if (spaceStationRunning()) {
    throw new Error('flydigi: Flydigi Space Station (or its background service) is running. Close it fully, then press Read pad again.')
  }
  const script = join(__dirname, '../../scripts/flydigi-switch-to-dinput.py')
  const out = join(tmpdir(), `flydigi-switch-${Date.now()}.json`)
  const py = process.env.FLYDIGI_PYTHON ?? 'python'
  const ps =
    `$p = Start-Process -FilePath ${psq(py)} -ArgumentList @(${psq(`"${script}"`)}, '--out', ${psq(`"${out}"`)}) ` +
    `-Verb RunAs -WindowStyle Hidden -PassThru -Wait; exit $p.ExitCode`
  const code = await new Promise<number>((resolve) => {
    const c = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true })
    c.on('error', () => resolve(-1))
    c.on('exit', (n) => resolve(n ?? -1))
  })
  let detail: string | null = null
  try {
    if (existsSync(out)) {
      const r = JSON.parse(readFileSync(out, 'utf8')) as { ok: boolean; error?: string }
      if (!r.ok) detail = r.error ?? 'the helper reported a failure'
      rmSync(out, { force: true })
    }
  } catch {
    /* fall through to the generic messages */
  }
  if (detail) throw new Error(`flydigi: switching to DInput failed: ${detail}`)
  if (code !== 0) throw new Error('flydigi: switching to DInput did not run — the Windows permission prompt was declined, or python could not be started (set FLYDIGI_PYTHON).')
  for (let i = 0; i < 48; i++) {
    if (dinputPath()) return
    await sleep(250)
  }
  throw new Error('flydigi: the switch was sent but the pad did not appear as 04B4:2412. Unplug and replug it and try again.')
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
  return { cfgId, activeCfgId, cfgCount, dataVersion: fxDataVersion(blob), vibration: fxDecodeVibration(blob), sticks: fxDecodeSticks(blob), curves: fxDecodeCurves(blob), triggers: fxDecodeTriggers(blob), keys: fxDecodeKeys(blob) }
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

export function fxHidWrite(patch: FxPatch): Promise<{ verified: boolean; restored: boolean; saved: boolean; changedPacks: number }> {
  return exclusive(async () => {
    await ensureOpen()
    const { cfgId, activeCfgId, blob: before } = await readBlob(patch.cfgId)
    try {
      const dir = join(app.getPath('userData'), 'flydigi-backups')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, `fp4-cfg${cfgId}-${new Date().toISOString().replace(/[:.]/g, '-')}.bin`), before)
    } catch {
      /* a failed backup must not block a write the rollback still covers */
    }

    let want = before
    if (patch.vibration) want = fxEncodeVibration(want, patch.vibration)
    if (patch.leftCenter !== undefined) want = fxSetStickCenter(want, 0, patch.leftCenter)
    if (patch.rightCenter !== undefined) want = fxSetStickCenter(want, 1, patch.rightCenter)
    if (patch.leftCurve) want = fxSetCurve(want, 0, patch.leftCurve)
    if (patch.rightCurve) want = fxSetCurve(want, 1, patch.rightCurve)
    for (const [id, target] of Object.entries(patch.keys ?? {})) want = fxSetKeyTarget(want, Number(id), target)
    if (patch.leftTrigger) want = fxSetTrigger(want, 0, patch.leftTrigger)
    if (patch.rightTrigger) want = fxSetTrigger(want, 1, patch.rightTrigger)
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
    if (patch.save && cfgId === activeCfgId) {
      acks = []
      await sendFrame(fxSave(fxDataVersion(after)))
      const a = await waitAck(FX_CMD_SAVE, (x) => x.data[0] === 3, 12000)
      saved = !!a && fxSaveAcked(a)
    }
    return { verified: true, restored: false, saved, changedPacks }
  })
}

/**
 * Send Space Station's SwitchToXInput (05 ED) and wait for the pad to leave
 * DInput mode. The pad drops off the bus and returns as 045E:028E, after which
 * Stick Labs can no longer configure it until it is put back in DInput mode.
 */
export function fxHidSwitchToXInput(): Promise<{ switched: boolean }> {
  return exclusive(async () => {
    open()
    try {
      hid!.write(Array.from(fxDInputSwitchToXInput()))
    } catch (e) {
      close()
      throw new Error(`flydigi: write failed (${(e as Error).message})`)
    }
    const end = Date.now() + 6000
    while (Date.now() < end) {
      await sleep(250)
      if (dinputPath() === null) {
        close()
        return { switched: true }
      }
    }
    return { switched: false }
  })
}

export function fxHidStop(): void {
  close()
}
