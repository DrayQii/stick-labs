/**
 * Flydigi XInput-mode (Direwolf 4) config session: read, verified write, save.
 *
 * Transport is scripts/flydigi-xinput-sidecar.py, which relays raw frames to
 * Space Station's Xbox 360 filter driver. Needs an elevated process and Space
 * Station (and its service) closed. Every write is read back; a mismatch is
 * rolled back to the config captured just before the write. Protocol framing:
 * src/shared/flydigi-xinput.ts, docs/flydigi.md.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  FX_CMD_READ_CFG_ACK,
  FX_CMD_SAVE,
  FX_CMD_WRITE_PACK,
  FX_CMD_WRITE_START,
  fxAssembleBlob,
  fxCfgIdFromAck,
  fxDataVersion,
  fxDecodeCurves,
  fxDecodeSticks,
  fxDecodeVibration,
  fxDiffPacks,
  fxEncodeVibration,
  fxParseAck,
  fxReadConfig,
  fxReadConfigId,
  fxRunFrames,
  fxSave,
  fxSaveAcked,
  fxSetCurve,
  fxSetStickCenter,
  type FxAck,
  type FxPatch,
  type FxSnapshot,
  FX_CMD_READ_CFG_ID
} from '../shared/flydigi-xinput'

const SIDECAR = join(__dirname, '../../scripts/flydigi-xinput-sidecar.py')
const ACK_TIMEOUT_MS = 2000
const READ_SETTLE_MS = 2500

let child: ChildProcessWithoutNullStreams | null = null
let ready: Promise<void> | null = null
let nextId = 1
const pending = new Map<number, (r: { ok: boolean; error?: string }) => void>()
let acks: FxAck[] = []
let busy = Promise.resolve()

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function start(): Promise<void> {
  if (ready) return ready
  ready = new Promise<void>((resolve, reject) => {
    const p = spawn(process.env.FLYDIGI_PYTHON ?? 'python', [SIDECAR], { stdio: 'pipe' })
    child = p
    let buf = ''
    let settled = false
    const fail = (msg: string): void => {
      if (!settled) {
        settled = true
        reject(new Error(msg))
      }
      child = null
      ready = null
    }
    p.on('error', (e) => fail(`flydigi: cannot start python (${e.message}); set FLYDIGI_PYTHON`))
    p.on('exit', () => {
      for (const cb of pending.values()) cb({ ok: false, error: 'sidecar exited' })
      pending.clear()
      fail('flydigi: sidecar exited (run elevated, close Space Station and its service)')
    })
    p.stderr.on('data', () => undefined)
    p.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let msg: { id?: number; ok?: boolean; error?: string; report?: string; fatal?: string }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.fatal) fail(`flydigi: ${msg.fatal}`)
        else if (msg.report) {
          const ack = fxParseAck(new Uint8Array(Buffer.from(msg.report, 'hex')))
          if (ack) acks.push(ack)
        } else if (typeof msg.id === 'number') {
          pending.get(msg.id)?.({ ok: !!msg.ok, error: msg.error })
          pending.delete(msg.id)
        }
      }
    })
    // The sidecar emits no "ready"; a ping proves the filter is attached.
    void rpc({ op: 'ping' }).then(
      (r) => {
        if (!r.ok) return fail(`flydigi: ${r.error ?? 'ping failed'}`)
        settled = true
        resolve()
      },
      (e) => fail(String(e))
    )
  })
  return ready
}

function rpc(req: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    if (!child) return resolve({ ok: false, error: 'sidecar not running' })
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ ok: false, error: 'sidecar timeout' })
    }, ACK_TIMEOUT_MS * 2)
    pending.set(id, (r) => {
      clearTimeout(timer)
      resolve(r)
    })
    child.stdin.write(JSON.stringify({ id, ...req }) + '\n')
  })
}

async function sendFrame(frame: Uint8Array): Promise<void> {
  const r = await rpc({ op: 'send', hex: Buffer.from(frame).toString('hex') })
  if (!r.ok) throw new Error(`flydigi: write failed (${r.error ?? 'no detail'})`)
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

async function readBlob(): Promise<{ cfgId: number; blob: Uint8Array }> {
  acks = []
  await sendFrame(fxReadConfigId())
  const idAck = await waitAck(FX_CMD_READ_CFG_ID)
  if (!idAck) throw new Error('flydigi: no reply to read-config-id (is the pad in USB mode?)')
  const cfgId = fxCfgIdFromAck(idAck)
  acks = []
  await sendFrame(fxReadConfig(cfgId))
  await sleep(READ_SETTLE_MS)
  const blob = fxAssembleBlob(acks.filter((a) => a.cmd === FX_CMD_READ_CFG_ACK))
  if (!blob) throw new Error('flydigi: incomplete config read; try again')
  return { cfgId, blob }
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

function snapshot(cfgId: number, blob: Uint8Array): FxSnapshot {
  return { cfgId, dataVersion: fxDataVersion(blob), vibration: fxDecodeVibration(blob), sticks: fxDecodeSticks(blob), curves: fxDecodeCurves(blob) }
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

export function fxXInputRead(): Promise<FxSnapshot> {
  return exclusive(async () => {
    await start()
    const { cfgId, blob } = await readBlob()
    return snapshot(cfgId, blob)
  })
}

export function fxXInputWrite(patch: FxPatch): Promise<{ verified: boolean; restored: boolean; saved: boolean; changedPacks: number }> {
  return exclusive(async () => {
    await start()
    const { cfgId, blob: before } = await readBlob()
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
    const changedPacks = fxDiffPacks(before, want).reduce((n, r) => n + r.packs.length, 0)
    if (changedPacks === 0) return { verified: true, restored: false, saved: false, changedPacks }

    await writeBlob(cfgId, before, want)
    const { blob: after } = await readBlob()
    const verified = after.length === want.length && after.every((v, i) => v === want[i])
    if (!verified) {
      // Roll the changed packs back to what was there before and re-check.
      let restored = false
      try {
        await writeBlob(cfgId, after, before)
        const { blob: again } = await readBlob()
        restored = again.every((v, i) => v === before[i])
      } catch {
        /* report below */
      }
      return { verified: false, restored, saved: false, changedPacks }
    }

    let saved = false
    if (patch.save) {
      acks = []
      await sendFrame(fxSave(fxDataVersion(after)))
      const a = await waitAck(FX_CMD_SAVE, (x) => x.data[0] === 3, 12000)
      saved = !!a && fxSaveAcked(a)
    }
    return { verified: true, restored: false, saved, changedPacks }
  })
}

export function fxXInputStop(): void {
  child?.kill()
  child = null
  ready = null
}
