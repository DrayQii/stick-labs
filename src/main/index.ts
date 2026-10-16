/**
 * G7 Stick Lab — stick-only Electron main. No remap/macros/lighting code.
 * IPC: discover/connect, profile 1-4 read/write (verified), switch, calibration.
 */
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import { join } from 'node:path'
import { Controller, type DeviceInfo } from './controller'
import { discover, discoverLive } from './hid'
import { ljReadButtonTable, ljReadMainSnapshot, ljReadSnapshot, ljWriteButtonVerified, ljWriteStickVerified, ljWriteTriggerVerified } from './leadjoy'
import type { LjButtonTarget, LjStickPatch } from '../shared/leadjoy'
import { fdIdentify } from './flydigi'
import { fxXInputActivate, fxXInputRead, fxXInputWrite, fxXInputStop } from './flydigi-xinput'
import type { FxPatch } from '../shared/flydigi-xinput'
import { ljButtonWriteRecord } from '../shared/leadjoy'
import { steamInfo, exportApexDeadzones, listInstalledGames, exportDeadzonesToGames } from './steam'
import { PROFILE_LENGTH } from '../shared/protocol'
import { runDeepPoll } from './deeppoll'

const controller = new Controller()
let window_: BrowserWindow | null = null

function send(channel: string, ...args: unknown[]): void {
  if (window_ && !window_.isDestroyed()) window_.webContents.send(channel, ...args)
}

const INPUT_SAMPLE_MS = 33
let lastSampleAt = 0
let samplePending = false

controller.onInput(() => {
  const now = Date.now()
  const emit = (): void => {
    lastSampleAt = Date.now()
    const input = controller.latestInput
    if (input) send('input:sample', input)
  }
  if (now - lastSampleAt < INPUT_SAMPLE_MS) {
    if (samplePending) return
    samplePending = true
    setTimeout(() => {
      samplePending = false
      emit()
    }, INPUT_SAMPLE_MS)
    return
  }
  emit()
})

controller.transport.on('stats', (stats) => send('device:stats', stats))

const sleepMs = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

let reconnecting = false
let sessionEpoch = 0
/**
 * The pad drops its USB interface for ~1-2 s when a change is applied live
 * (write to the running slot, or switch onto a changed slot). Instead of
 * making the user Rescan + Connect by hand, re-open the first stable
 * interface: the PID reappears before it is usable, so presence is
 * re-checked after a gap before opening (same lesson as the write path).
 * Gives up after ~30 s and falls back to manual reconnect.
 */
async function autoReconnect(reason: string): Promise<void> {
  if (reconnecting) return
  reconnecting = true
  const epoch = sessionEpoch
  try {
    send('device:reconnecting', reason)
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      if (epoch !== sessionEpoch || controller.transport.isOpen) return
      await sleepMs(800)
      if (epoch !== sessionEpoch || controller.transport.isOpen) return
      const cands = discover()
      const target = cands.find((c) => c.preferred) ?? cands[0]
      if (!target) continue
      await sleepMs(600)
      if (epoch !== sessionEpoch || controller.transport.isOpen) return
      if (!discover().some((c) => c.path === target.path)) continue
      try {
        const info = await controller.connect(target.path)
        controller.attachInputDecoder()
        controller.transport.startWatchdog(4000, () => void autoReconnect('silent'))
        send('device:reconnected', info)
        return
      } catch {
        /* keep trying until the deadline */
      }
    }
    send('device:stale', controller.transport.currentPath)
  } finally {
    reconnecting = false
  }
}

controller.transport.on('disconnected', (err: Error) => {
  void autoReconnect(err?.message ?? 'disconnected')
})

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}
function fromB64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64'))
}
function handle(channel: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? String(err) }
    }
  })
}

handle('device:discover', () => discoverLive())
/** Flydigi: read-only identify handshake (docs/flydigi.md). No write path exists. */
handle('flydigi:identify', (path: string) => {
  if (typeof path !== 'string' || path.length === 0) throw new Error('flydigi: refusing identify without a device path')
  return fdIdentify(path)
})
/** Flydigi Direwolf 4 (XInput mode): config via Space Station's filter driver (docs/flydigi.md). Needs elevation. */
const cfgOk = (v: unknown): boolean => v === undefined || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 7)
handle('flydigix:read', (cfgId?: number) => {
  if (!cfgOk(cfgId)) throw new Error('flydigi: config id must be 0..7')
  return fxXInputRead(cfgId)
})
handle('flydigix:activate', (cfgId: number) => {
  if (!Number.isInteger(cfgId) || cfgId < 0 || cfgId > 7) throw new Error('flydigi: config id must be 0..7')
  return fxXInputActivate(cfgId)
})
handle('flydigix:write', (patch: FxPatch) => {
  const byte = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 255
  if (!patch || typeof patch !== 'object') throw new Error('flydigi: empty patch')
  if (!cfgOk(patch.cfgId)) throw new Error('flydigi: config id must be 0..7')
  if (patch.leftCenter !== undefined && !byte(patch.leftCenter)) throw new Error('flydigi: leftCenter must be 0..255')
  if (patch.rightCenter !== undefined && !byte(patch.rightCenter)) throw new Error('flydigi: rightCenter must be 0..255')
  for (const c of [patch.leftCurve, patch.rightCurve]) {
    if (c && !(Array.isArray(c.points) && c.points.length === 9 && [...c.points, c.type, c.circularity, c.edge].every(byte))) {
      throw new Error('flydigi: a curve needs 9 points and type/circularity/edge as bytes 0..255')
    }
  }
  const v = patch.vibration
  if (v && ![v.left?.min, v.left?.max, v.left?.scale, v.right?.min, v.right?.max, v.right?.scale].every(byte)) {
    throw new Error('flydigi: vibration values must be 0..255')
  }
  return fxXInputWrite(patch)
})
handle('leadjoy:readMain', (path: string) => ljReadMainSnapshot(path))
handle('leadjoy:readSlot', (req: { path: string; slot: number }) => {
  if (typeof req?.path !== 'string' || req.path.length === 0) throw new Error('leadjoy: refusing read without a device path')
  if (req.slot !== 0 && req.slot !== 1 && req.slot !== 2) throw new Error(`leadjoy: slot ${req.slot} is not Main/Sub1/Sub2`)
  return ljReadSnapshot(req.path, req.slot)
})
/**
 * LeadJoy extra-button remap (tournament-safe 1:1 only). Target is a button
 * id (A=1 B=2 X=4 Y=5) or null for stock/Origin; anything else is refused
 * here, not just in the UI. Proven path: single-record 61/w write + ack +
 * readback (docs/leadjoy-saber.md).
 */
handle('leadjoy:writeButton', async (req: { path: string; slot: number; id: number; target: LjButtonTarget | null }) => {
  const { path, slot, id, target } = req ?? {}
  if (typeof path !== 'string' || path.length === 0) throw new Error('leadjoy: refusing write without a device path')
  if (slot !== 0 && slot !== 1 && slot !== 2) throw new Error(`leadjoy: slot ${slot} is not Main/Sub1/Sub2`)
  return ljWriteButtonVerified(path, slot, ljButtonWriteRecord(id, target))
})
handle('leadjoy:writeStick', async (req: { path: string; slot: number; side: number; patch: Record<string, unknown> }) => {
  const { path, slot, side, patch } = req ?? {}
  if (typeof path !== 'string' || path.length === 0) throw new Error('leadjoy: refusing write without a device path')
  if (slot !== 0 && slot !== 1 && slot !== 2) throw new Error(`leadjoy: slot ${slot} is not Main/Sub1/Sub2`)
  if (side !== 0 && side !== 1) throw new Error(`leadjoy: side ${side} is not left/right`)
  return ljWriteStickVerified(path, slot, side, (patch ?? {}) as LjStickPatch)
})
handle('leadjoy:writeTrigger', async (req: { path: string; slot: number; zones: { leftInner: number; leftOuter: number; rightInner: number; rightOuter: number } }) => {
  const { path, slot, zones } = req ?? {}
  if (typeof path !== 'string' || path.length === 0) throw new Error('leadjoy: refusing write without a device path')
  if (slot !== 0 && slot !== 1 && slot !== 2) throw new Error(`leadjoy: slot ${slot} is not Main/Sub1/Sub2`)
  return ljWriteTriggerVerified(path, slot, zones)
})
handle('device:connect', async (path: string): Promise<DeviceInfo> => {
  sessionEpoch++
  const info = await controller.connect(path)
  controller.attachInputDecoder()
  controller.transport.startWatchdog(4000, () => void autoReconnect('silent'))
  return info
})
handle('device:disconnect', () => {
  sessionEpoch++
  controller.disconnect()
  return true
})
handle('profile:read', async (profile: number, total?: number) => {
  const length = total ?? PROFILE_LENGTH
  if (!Number.isInteger(length) || length < 100 || length > 4096) throw new Error(`refusing read of ${length} bytes`)
  const bytes = await controller.readProfile(profile, length)
  return { bytes: b64(bytes), length: bytes.length }
})
handle('profile:write', async (profile: number, dataB64: string, length?: number) => {
  const bytes = fromB64(dataB64)
  const total = length ?? PROFILE_LENGTH
  if (bytes.length !== total) throw new Error(`payload is ${bytes.length} bytes, expected ${total}`)
  return controller.writeProfileVerified(profile, bytes, total)
})
handle('profile:switch', async (profile: number) => {
  await controller.switchProfile(profile)
  return true
})
handle('profile:current', async () => controller.getCurrentProfile())
handle('device:calibration', (state: number) => {
  controller.calibration(state)
  return true
})
handle('device:stickCenter', async (stick: number, direction: number) => {
  await controller.nudgeCenter(stick, direction)
  return true
})
handle('system:openExternal', (url: string) => {
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw new Error('blocked URL')
  void shell.openExternal(url)
  return true
})
handle('system:version', () => app.getVersion())
handle('steam:info', () => steamInfo())
handle('steam:export', (left: { begin: number; end: number }, right: { begin: number; end: number }, mouseRate?: number | null, curveExp?: number | null) =>
  exportApexDeadzones(left, right, mouseRate ?? null, curveExp ?? null)
)
handle('steam:games', () => listInstalledGames())
handle('steam:exportAll', (left: { begin: number; end: number }, right: { begin: number; end: number }, mouseRate?: number | null, curveExp?: number | null) => {
  const games = listInstalledGames()
  return { games: listInstalledGames(), result: exportDeadzonesToGames(left, right, games, mouseRate ?? null, curveExp ?? null) }
})
handle('diag:ping', async (count: number) => {
  const n = Math.max(1, Math.min(50, count))
  const samples: number[] = []
  for (let i = 0; i < n; i++) {
    const started = performance.now()
    await controller.getCurrentProfile()
    samples.push(performance.now() - started)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    count: samples.length,
    samples,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    median: sorted[Math.floor(sorted.length / 2)],
    mean: samples.reduce((a, b) => a + b, 0) / samples.length
  }
})
handle('diag:deeppoll', async (vid: number, pid: number, seconds?: number) => {
  if (!Number.isInteger(vid) || !Number.isInteger(pid)) throw new Error('refusing deep poll without VID:PID')
  return runDeepPoll({ vid, pid, seconds })
})

function createWindow(): void {
  window_ = new BrowserWindow({
    width: 1220,
    height: 860,
    minWidth: 1000,
    minHeight: 680,
    backgroundColor: '#14090d',
    title: 'Stick Labs',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) void window_.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void window_.loadFile(join(__dirname, '../renderer/index.html'))
  if (!app.isPackaged) {
    // The menu bar is hidden, so give dev runs an explicit devtools shortcut.
    window_.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
        window_?.webContents.toggleDevTools()
      }
    })
  }
  window_.on('closed', () => {
    window_ = null
  })
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    // WebHID for Flydigi pads (kept for a future WebHID transport; the
    // identify handshake itself goes through node-hid in main/flydigi.ts).
    // requestDevice still needs a user gesture; this only stops auto-deny.
    // (cast: Electron's Permission union predates the 'hid' literal.)
    callback((permission as string) === 'hid')
  })
  // This is the actual WebHID gate in Electron: without it the device
  // picker comes up empty. GameSir path is unaffected (node-hid).
  session.defaultSession.setDevicePermissionHandler((details) => {
    if (details.deviceType !== 'hid') return false
    const device = details.device as unknown as { vendorId?: number } | undefined
    // device may be undefined on some code paths — grant those too, the
    // requestDevice filters + user pick remain the real gate.
    return device?.vendorId === undefined || device.vendorId === 0x37d7
  })
  createWindow()

  // Self-update from GitHub Releases (packaged builds only — never in dev).
  if (app.isPackaged) {
    try {
      const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
      autoUpdater.autoDownload = true
      void autoUpdater.checkForUpdatesAndNotify()
      autoUpdater.on('update-downloaded', () => {
        if (!window_ || window_.isDestroyed()) return
        void dialog
          .showMessageBox(window_, {
            type: 'info',
            buttons: ['Restart now', 'Later'],
            defaultId: 0,
            message: 'Stick Labs update downloaded — restart to install it?'
          })
          .then(({ response }) => {
            if (response === 0) autoUpdater.quitAndInstall()
          })
      })
    } catch (err) {
      console.error(`[updater] disabled: ${(err as Error).message}`)
    }
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})
app.on('window-all-closed', () => {
  controller.disconnect()
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', () => {
  controller.disconnect()
  fxXInputStop()
})
