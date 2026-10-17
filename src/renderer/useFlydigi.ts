/**
 * Flydigi Direwolf 4 session state for the main app: read/apply a config slot, switch modes, set the
 * polling rate, activate a slot, back up and restore. The tabs (Sticks / Buttons / Device / Profiles)
 * render pieces of it (FlydigiSections.tsx); the topbar drives slots and Write.
 *
 * Plain HID in DInput mode with Space Station closed (docs/flydigi.md). Every write is read back by
 * the main process and rolled back on mismatch.
 */
import { useCallback, useEffect, useState } from 'react'
import { FX_CURVE_CUSTOM, fxDeadzonePoints, fxHzFromReportRate, type FxCurve, type FxMotion, type FxSnapshot, type FxTriggerRaw, type FxTurbo, type FxVibration } from '@shared/flydigi-xinput'
import { api } from './api'
import { fxFmt } from './i18n-fx'
import { tr, type Lang } from './i18n'

export type FxMsg = { kind: 'ok' | 'err'; text: string }
export type FxBackup = { name: string; cfgId: number; time: string }
export type FxMode = 'dinput' | 'xinput' | 'none'

const sc = (b: number): number => (b > 127 ? b - 256 : b)
const sig = (vib: FxVibration | null, l: number, r: number, c: { left: FxCurve; right: FxCurve } | null, t: { left: FxTriggerRaw; right: FxTriggerRaw } | null): string =>
  JSON.stringify([vib, l, r, c, t])

export function useFlydigi(onLost: () => void, lang: Lang) {
  const t = (key: string, vars: Record<string, string | number> = {}): string => fxFmt(tr(lang, key), vars)
  /** A pad error from the main process; the common XInput-mode one is shown in the user's language. */
  const errText = (e: unknown): string => {
    const m = (e as Error).message
    return /the pad is in XInput mode/i.test(m) ? t('fx.err.xinputMode') : m
  }
  const [active, setActive] = useState(false)
  const [snap, setSnap] = useState<FxSnapshot | null>(null)
  const [vib, setVib] = useState<FxVibration | null>(null)
  const [left, setLeft] = useState(0)
  const [right, setRight] = useState(0)
  const [keyEdits, setKeyEdits] = useState<Record<number, number>>({})
  const [motion, setMotion] = useState<FxMotion | null>(null)
  const [turboEdits, setTurboEdits] = useState<Record<number, FxTurbo | null>>({})
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
    setTurboEdits({})
    setMotion(s.motion)
    setBase(sig(s.vibration, l, r, s.curves, s.triggers))
  }

  /** The gyro fields the user changed (so unedited bytes are never rewritten), or null. */
  function motionDiff(): Partial<FxMotion> | null {
    if (!snap || !motion) return null
    const d: Partial<FxMotion> = {}
    for (const k of Object.keys(motion) as (keyof FxMotion)[]) if (motion[k] !== snap.motion[k]) d[k] = motion[k]
    return Object.keys(d).length > 0 ? d : null
  }

  const dirty = !!snap && (sig(vib, left, right, curves, triggers) !== base || motionDiff() !== null || Object.keys(keyEdits).length > 0 || Object.keys(turboEdits).length > 0)

  /** Read a slot (the active one when omitted). Returns whether it worked; marks the pad connected on success. */
  async function load(cfgId?: number, viaDriver = false): Promise<boolean> {
    setBusy(true)
    setMsg({ kind: 'ok', text: viaDriver ? t('fx.msg.driverSwitching') : t('fx.msg.reading') })
    try {
      adopt(await api().flydigiXRead(cfgId, viaDriver))
      setActive(true)
      setMsg({ kind: 'ok', text: cfgId === undefined ? t('fx.msg.readActive') : t('fx.msg.readConfig', { n: cfgId + 1 }) })
      return true
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e) })
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
    setMotion(null)
    setKeyEdits({})
    setTurboEdits({})
    setMsg(null)
  }

  async function toXInput(): Promise<void> {
    const ok = window.confirm(t('fx.msg.toXInputConfirm'))
    if (!ok) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await api().flydigiXToXInput()
      if (r.switched) {
        disconnect()
        onLost()
      } else {
        setMsg({ kind: 'err', text: t('fx.msg.notLeftDInput') })
      }
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e) })
    } finally {
      setBusy(false)
    }
  }

  async function pollingRate(code: number | null): Promise<void> {
    if (code !== null) {
      const hz = fxHzFromReportRate(code)
      const ok = window.confirm(t('fx.msg.rateConfirm', { hz: hz ?? '?' }))
      if (!ok) return
    }
    setBusy(true)
    setMsg({ kind: 'ok', text: code === null ? t('fx.msg.rateReading') : t('fx.msg.rateSetting') })
    try {
      const r = await api().flydigiXRate(code)
      setRate(r.reportRate)
      const hz = fxHzFromReportRate(r.reportRate)
      setMsg(
        r.verified
          ? { kind: 'ok', text: code === null ? t('fx.msg.rateIs', { hz: hz ?? t('fx.msg.rateUnknown') }) : t('fx.msg.rateSet', { hz: hz ?? '?' }) }
          : { kind: 'err', text: t('fx.msg.rateNotConfirmed') }
      )
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e) })
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
      setMsg({ kind: 'ok', text: t('fx.msg.nowActive', { n: snap.cfgId + 1 }) })
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e) })
    } finally {
      setBusy(false)
    }
  }

  /** Switch to another slot; asks first when there are unwritten edits. */
  async function selectSlot(cfgId: number): Promise<void> {
    if (dirty && !window.confirm(t('fx.msg.discard'))) return
    await load(cfgId)
  }

  async function backupNow(): Promise<void> {
    if (!snap) return
    setBusy(true)
    setMsg(null)
    try {
      await api().flydigiXBackup(snap.cfgId)
      refreshBackups()
      setMsg({ kind: 'ok', text: t('fx.msg.backedUp', { n: snap.cfgId + 1 }) })
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e) })
    } finally {
      setBusy(false)
    }
  }

  async function restore(b: FxBackup): Promise<void> {
    if (!window.confirm(t('fx.msg.restoreConfirm', { time: new Date(b.time).toLocaleString(), n: b.cfgId + 1 }))) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await api().flydigiXRestore(b.name, save)
      if (!r.verified) {
        setMsg({ kind: 'err', text: r.restored ? t('fx.msg.mismatchRolledBackPrev') : t('fx.msg.mismatchNoRollback') })
      } else if (r.changedPacks === 0) {
        setMsg({ kind: 'ok', text: t('fx.msg.alreadyMatches', { n: r.cfgId + 1 }) })
      } else {
        setMsg({ kind: 'ok', text: t('fx.msg.restored', { n: r.cfgId + 1 }) + (save && r.saved ? t('fx.msg.savedToPad') : t('fx.msg.liveOnly')) })
      }
      adopt(await api().flydigiXRead(r.cfgId))
      refreshBackups()
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e) })
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
        turbo: turboEdits,
        motion: motionDiff() ?? undefined,
        leftTrigger: triggers.left,
        rightTrigger: triggers.right,
        save
      })
      if (!r.verified) {
        setMsg({ kind: 'err', text: r.restored ? t('fx.msg.mismatchRolledBackConfig') : t('fx.msg.mismatchNoRollback') })
      } else if (r.changedPacks === 0) {
        setMsg({ kind: 'ok', text: t('fx.msg.nothingToChange') })
      } else {
        setMsg({ kind: 'ok', text: t('fx.msg.written', { n: r.changedPacks, s: r.changedPacks === 1 ? '' : 's' }) + (save && snap.cfgId === snap.activeCfgId ? (r.saved ? t('fx.msg.savedToPad') : t('fx.msg.saveNotAcked')) : t('fx.msg.liveOnly')) })
      }
      adopt(await api().flydigiXRead(snap.cfgId))
      refreshBackups()
    } catch (e) {
      setMsg({ kind: 'err', text: errText(e) })
    } finally {
      setBusy(false)
    }
  }

  const edgeOf = (c: { left: FxCurve; right: FxCurve } | null, side: 'left' | 'right'): number => (c ? sc(c[side].edge) : 0)

  /** Centre slider (-100..100): sets the stick's centre byte and regenerates the curve for the current edge. */
  const setDeadzone = (side: 'left' | 'right', d: number): void => {
    ;(side === 'left' ? setLeft : setRight)(d)
    setCurves((c) => (c ? { ...c, [side]: { ...c[side], type: FX_CURVE_CUSTOM, points: fxDeadzonePoints(d, edgeOf(c, side)) } } : c))
  }

  /** Edge slider (-100..100): stored as a signed byte in the curve record; regenerates the curve for the current centre. */
  const setEdge = (side: 'left' | 'right', e: number): void => {
    const centre = side === 'left' ? left : right
    setCurves((c) => (c ? { ...c, [side]: { ...c[side], type: FX_CURVE_CUSTOM, edge: e & 0xff, points: fxDeadzonePoints(centre, e) } } : c))
  }

  const setMotor = (side: 'left' | 'right', patch: Partial<FxVibration['left']>): void =>
    setVib((v) => (v ? { ...v, [side]: { ...v[side], ...patch } } : v))

  return {
    sc, active, snap, vib, setVib, motion, setMotion, left, right, keyEdits, setKeyEdits, turboEdits, setTurboEdits, triggers, setTriggers, curves, setCurves,
    save, setSave, busy, rate, mode, msg, setMsg, backups, dirty,
    load, disconnect, toXInput, pollingRate, activate, selectSlot, backupNow, restore, apply, setDeadzone, setEdge, setMotor
  }
}

export type Flydigi = ReturnType<typeof useFlydigi>
