/**
 * Flydigi Direwolf 4 session state for the main app: read/apply a config slot, switch modes, set the
 * polling rate, activate a slot, back up and restore. The tabs (Sticks / Buttons / Device / Profiles)
 * render pieces of it (FlydigiSections.tsx); the topbar drives slots and Write.
 *
 * Plain HID in DInput mode with Space Station closed (docs/flydigi.md). Every write is read back by
 * the main process and rolled back on mismatch.
 */
import { useCallback, useEffect, useState } from 'react'
import { FX_CURVE_CUSTOM, fxDeadzonePoints, fxHzFromReportRate, type FxCurve, type FxSnapshot, type FxTriggerRaw, type FxVibration } from '@shared/flydigi-xinput'
import { api } from './api'

export type FxMsg = { kind: 'ok' | 'err'; text: string }
export type FxBackup = { name: string; cfgId: number; time: string }
export type FxMode = 'dinput' | 'xinput' | 'none'

const sc = (b: number): number => (b > 127 ? b - 256 : b)
const sig = (vib: FxVibration | null, l: number, r: number, c: { left: FxCurve; right: FxCurve } | null, t: { left: FxTriggerRaw; right: FxTriggerRaw } | null): string =>
  JSON.stringify([vib, l, r, c, t])

export function useFlydigi(onLost: () => void) {
  const [active, setActive] = useState(false)
  const [snap, setSnap] = useState<FxSnapshot | null>(null)
  const [vib, setVib] = useState<FxVibration | null>(null)
  const [left, setLeft] = useState(0)
  const [right, setRight] = useState(0)
  const [keyEdits, setKeyEdits] = useState<Record<number, number>>({})
  const [triggers, setTriggers] = useState<{ left: FxTriggerRaw; right: FxTriggerRaw } | null>(null)
  const [curves, setCurves] = useState<{ left: FxCurve; right: FxCurve } | null>(null)
  const [base, setBase] = useState('')
  const [save, setSave] = useState(true)
  const [busy, setBusy] = useState(false)
  const [rate, setRate] = useState<number | null>(null)
  const [mode, setMode] = useState<FxMode | null>(null)
  const [msg, setMsg] = useState<FxMsg | null>(null)
  const [backups, setBackups] = useState<FxBackup[]>([])

  // Follow the pad's real mode (it changes on replug, mode switches and when Space Station launches).
  useEffect(() => {
    let alive = true
    const poll = (): void => {
      api()
        .flydigiXMode()
        .then((m) => alive && setMode(m))
        .catch(() => undefined)
    }
    poll()
    const t = setInterval(poll, 2000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const refreshBackups = useCallback((): void => {
    api()
      .flydigiXBackups()
      .then(setBackups)
      .catch(() => undefined)
  }, [])
  useEffect(refreshBackups, [refreshBackups])

  const adopt = (s: FxSnapshot): void => {
    const l = sc(s.sticks.left.center)
    const r = sc(s.sticks.right.center)
    setSnap(s)
    setVib(s.vibration)
    setLeft(l)
    setRight(r)
    setCurves(s.curves)
    setTriggers(s.triggers)
    setKeyEdits({})
    setBase(sig(s.vibration, l, r, s.curves, s.triggers))
  }

  const dirty = !!snap && (sig(vib, left, right, curves, triggers) !== base || Object.keys(keyEdits).length > 0)

  /** Read a slot (the active one when omitted). Returns whether it worked; marks the pad connected on success. */
  async function load(cfgId?: number): Promise<boolean> {
    setBusy(true)
    setMsg({ kind: 'ok', text: 'Reading the pad… if it is in XInput mode, Windows will ask permission to switch it to DInput (this takes a few seconds).' })
    try {
      adopt(await api().flydigiXRead(cfgId))
      setActive(true)
      setMsg({ kind: 'ok', text: cfgId === undefined ? 'Read the active config from the pad.' : `Read config ${cfgId + 1}.` })
      return true
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
      return false
    } finally {
      setBusy(false)
    }
  }

  function disconnect(): void {
    setActive(false)
    setSnap(null)
    setVib(null)
    setCurves(null)
    setTriggers(null)
    setKeyEdits({})
    setMsg(null)
  }

  async function toXInput(): Promise<void> {
    const ok = window.confirm(
      'Switch the Direwolf back to XInput mode?\n\nThe pad will disconnect and return as an Xbox 360 controller (for games). Stick Labs cannot configure it again until it is put back in DInput mode.'
    )
    if (!ok) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await api().flydigiXToXInput()
      if (r.switched) {
        disconnect()
        onLost()
      } else {
        setMsg({ kind: 'err', text: 'The pad did not leave DInput mode. Unplug and replug it, or check it in Windows Device Manager.' })
      }
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  async function pollingRate(code: number | null): Promise<void> {
    if (code !== null) {
      const hz = fxHzFromReportRate(code)
      const ok = window.confirm(
        `Set the polling rate to ${hz} Hz?\n\nThe pad only exposes this in XInput mode, so Stick Labs will briefly switch it to XInput, change the rate through the Flydigi driver (administrator step) and switch it back. It takes about 20 seconds; keep Flydigi Space Station closed.`
      )
      if (!ok) return
    }
    setBusy(true)
    setMsg({ kind: 'ok', text: code === null ? 'Reading the polling rate… (switches the pad to XInput and back, about 20 seconds)' : 'Setting the polling rate… (switches the pad to XInput and back, about 20 seconds)' })
    try {
      const r = await api().flydigiXRate(code)
      setRate(r.reportRate)
      const hz = fxHzFromReportRate(r.reportRate)
      setMsg(
        r.verified
          ? { kind: 'ok', text: code === null ? `Polling rate is ${hz ?? 'unknown'} Hz.` : `Polling rate set to ${hz} Hz (read back from the pad).` }
          : { kind: 'err', text: 'The pad did not confirm the polling rate.' }
      )
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  async function activate(): Promise<void> {
    if (!snap) return
    setBusy(true)
    setMsg(null)
    try {
      adopt(await api().flydigiXActivate(snap.cfgId))
      setMsg({ kind: 'ok', text: `Config ${snap.cfgId + 1} is now the active config on the pad.` })
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  /** Switch to another slot; asks first when there are unwritten edits. */
  async function selectSlot(cfgId: number): Promise<void> {
    if (dirty && !window.confirm('Discard your unwritten changes and switch config?')) return
    await load(cfgId)
  }

  async function backupNow(): Promise<void> {
    if (!snap) return
    setBusy(true)
    setMsg(null)
    try {
      await api().flydigiXBackup(snap.cfgId)
      refreshBackups()
      setMsg({ kind: 'ok', text: `Config ${snap.cfgId + 1} backed up.` })
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  async function restore(b: FxBackup): Promise<void> {
    if (!window.confirm(`Restore the backup from ${new Date(b.time).toLocaleString()} to config ${b.cfgId + 1}?\n\nThe slot's current contents are backed up first, so this can be undone.`)) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await api().flydigiXRestore(b.name, save)
      if (!r.verified) {
        setMsg({ kind: 'err', text: r.restored ? 'Readback mismatch — rolled back to what the slot held before.' : 'Readback mismatch and the rollback could not be confirmed. Re-read the pad.' })
      } else if (r.changedPacks === 0) {
        setMsg({ kind: 'ok', text: `Config ${r.cfgId + 1} already matches this backup.` })
      } else {
        setMsg({ kind: 'ok', text: `Config ${r.cfgId + 1} restored and verified${save && r.saved ? ', saved to the pad.' : ' — live only, not saved.'}` })
      }
      adopt(await api().flydigiXRead(r.cfgId))
      refreshBackups()
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  /** The topbar "Write to controller": send every edit, verified by readback. */
  async function apply(): Promise<void> {
    if (!snap || !vib || !curves || !triggers) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await api().flydigiXWrite({
        vibration: vib,
        leftCenter: left & 0xff,
        cfgId: snap.cfgId,
        rightCenter: right & 0xff,
        leftCurve: curves.left,
        rightCurve: curves.right,
        keys: keyEdits,
        leftTrigger: triggers.left,
        rightTrigger: triggers.right,
        save
      })
      if (!r.verified) {
        setMsg({ kind: 'err', text: r.restored ? 'Readback mismatch — rolled back to the previous config.' : 'Readback mismatch and the rollback could not be confirmed. Re-read the pad.' })
      } else if (r.changedPacks === 0) {
        setMsg({ kind: 'ok', text: 'Nothing to change.' })
      } else {
        setMsg({ kind: 'ok', text: `Written and verified (${r.changedPacks} pack${r.changedPacks === 1 ? '' : 's'})${save && snap.cfgId === snap.activeCfgId ? (r.saved ? ', saved to the pad.' : ', but the save was not acknowledged.') : ' — live only, not saved.'}` })
      }
      adopt(await api().flydigiXRead(snap.cfgId))
      refreshBackups()
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const setDeadzone = (side: 'left' | 'right', d: number): void => {
    ;(side === 'left' ? setLeft : setRight)(d)
    setCurves((c) => (c ? { ...c, [side]: { ...c[side], type: FX_CURVE_CUSTOM, points: fxDeadzonePoints(d) } } : c))
  }

  const setMotor = (side: 'left' | 'right', patch: Partial<FxVibration['left']>): void =>
    setVib((v) => (v ? { ...v, [side]: { ...v[side], ...patch } } : v))

  return {
    active, snap, vib, setVib, left, right, keyEdits, setKeyEdits, triggers, setTriggers, curves, setCurves,
    save, setSave, busy, rate, mode, msg, setMsg, backups, dirty,
    load, disconnect, toXInput, pollingRate, activate, selectSlot, backupNow, restore, apply, setDeadzone, setMotor
  }
}

export type Flydigi = ReturnType<typeof useFlydigi>
