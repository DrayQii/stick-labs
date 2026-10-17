/**
 * Flydigi Direwolf 4 tab content for the main app: one section per tab (Sticks, Buttons, Device,
 * Profiles). State and actions come from useFlydigi; the topbar owns slots and Write.
 */
import { FX_REPORT_RATES, fxHzFromReportRate, FX_KEY_DEFAULT, FX_KEY_NAMES, FX_KEY_ORDER, FX_MOTION_CLICK, FX_MOTION_LEFT, FX_MOTION_OFF, FX_MOTION_PRESS, FX_MOTION_RIGHT, FX_TURBO_CLICK, FX_TURBO_MAX, FX_TURBO_MIN, FX_TURBO_PRESS, fxTriggerRange, type FxLive, type FxMotion, type FxTurbo } from '@shared/flydigi-xinput'
import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import FlydigiCurveDesigner from './FlydigiCurveDesigner'
import { useT } from './i18n'
import { fxFmt } from './i18n-fx'
import FlydigiLiveView from './FlydigiLiveView'
import FlydigiSteam from './FlydigiSteam'
import type { FdV1Info } from '@shared/flydigi'
import type { Flydigi } from './useFlydigi'

function Num(props: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }): JSX.Element {
  return (
    <label style={{ display: 'block' }}>
      <div className="row spread">
        <span className="label">{props.label}</span>
        <span className="mono">{props.value}</span>
      </div>
      <input
        type="range"
        className="input"
        style={{ width: '100%' }}
        min={props.min}
        max={props.max}
        step={1}
        value={props.value}
        onChange={(e) => props.onChange(Number(e.target.value))}
      />
    </label>
  )
}


export function FxSticks({ fx }: { fx: Flydigi }): JSX.Element | null {
  const t = useT()
  const { snap, curves, setCurves, left, right, setDeadzone, setEdge, sc } = fx
  if (!snap || !curves) return null
  return (
    <>
          <div className="card" style={{ marginTop: 16 }}>
        <h3>{t('fx.live.title')}</h3>
        <div className="hint" style={{ margin: '4px 0 8px' }}>
          {t('fx.live.hint')}
        </div>
        <FlydigiLiveView />
          </div>
          <div className="card" style={{ marginTop: 16 }}>
            <h3>{t('nav.sticks')}</h3>
            <div className="hint" style={{ margin: '4px 0 8px' }}>
              {t('fx.sticks.hint')}
            </div>
            <Num label={t('fx.sticks.leftDz')} value={left} min={-100} max={100} onChange={(d) => setDeadzone('left', d)} />
            <Num label={t('fx.sticks.rightDz')} value={right} min={-100} max={100} onChange={(d) => setDeadzone('right', d)} />
            <Num label={t('fx.sticks.leftEdge')} value={sc(curves.left.edge)} min={-100} max={100} onChange={(e) => setEdge('left', e)} />
            <Num label={t('fx.sticks.rightEdge')} value={sc(curves.right.edge)} min={-100} max={100} onChange={(e) => setEdge('right', e)} />
            <div style={{ height: 10 }} />
            <h4 style={{ marginTop: 12 }}>{t('fx.curves.title')}</h4>
            <div className="hint" style={{ margin: '4px 0 8px' }}>
              {t('fx.curves.hint')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
              <FlydigiCurveDesigner
                title={t('fx.curves.left')}
                curve={curves.left}
                onChange={(c) => setCurves({ ...curves, left: c })}
                onCopyToOther={() => setCurves({ ...curves, right: { ...curves.left } })}
                copyLabel={t('fx.curves.copyToRight')}
              />
              <FlydigiCurveDesigner
                title={t('fx.curves.right')}
                curve={curves.right}
                onChange={(c) => setCurves({ ...curves, right: c })}
                onCopyToOther={() => setCurves({ ...curves, left: { ...curves.right } })}
                copyLabel={t('fx.curves.copyToLeft')}
              />
            </div>
          </div>

    </>
  )
}

export function FxButtons({ fx }: { fx: Flydigi }): JSX.Element | null {
  const t = useT()
  const { snap, keyEdits, setKeyEdits, turboEdits, setTurboEdits } = fx
  // Press a button on the pad: its card lights up and scrolls into view (live stream, flydigix:live).
  const [down, setDown] = useState<number[]>([])
  const downRef = useRef<number[]>([])
  const cards = useRef<Record<number, HTMLDivElement | null>>({})
  useEffect(
    () =>
      api().on('flydigix:live', (l: FxLive) => {
        const prev = downRef.current
        if (prev.length === l.ids.length && prev.every((id) => l.ids.includes(id))) return
        const fresh = l.ids.find((id) => !prev.includes(id) && id in FX_KEY_NAMES)
        if (fresh !== undefined) cards.current[fresh]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        downRef.current = l.ids
        setDown(l.ids)
      }),
    []
  )
  if (!snap) return null
  return (
    <>
          <div className="card" style={{ marginTop: 16 }}>
            <h3>{t('nav.buttons')}</h3>
            <div className="hint" style={{ margin: '4px 0 8px' }}>
              {t('fx.buttons.hint')} {t('fx.buttons.pressToFind')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(210px, 1fr))', gap: 8 }}>
              {FX_KEY_ORDER.map((id) => {
                const cur = snap.keys.find((k) => k.id === id)!
                const orig: FxTurbo | null = cur.kind === 'turbo' ? { type: cur.enableType, frequency: cur.frequency } : null
                const turbo = id in turboEdits ? turboEdits[id] : orig
                const macro = cur.kind === 'macro'
                const base = cur.kind === 'key' ? cur.target : FX_KEY_DEFAULT
                const value = id in keyEdits ? keyEdits[id] : id in turboEdits && turboEdits[id] === null ? FX_KEY_DEFAULT : base
                const edited = id in keyEdits || id in turboEdits
                const setTurbo = (next: FxTurbo | null): void => {
                  setKeyEdits((prev) => {
                    const k = { ...prev }
                    delete k[id]
                    return k
                  })
                  setTurboEdits((prev) => {
                    const t = { ...prev }
                    if (JSON.stringify(next) === JSON.stringify(orig)) delete t[id]
                    else t[id] = next
                    return t
                  })
                }
                return (
                  <div
                    key={id}
                    ref={(el) => (cards.current[id] = el)}
                    className="stack"
                    style={{ gap: 4, padding: 6, margin: -6, borderRadius: 4, outline: down.includes(id) ? '2px solid var(--accent, #f43f52)' : '2px solid transparent', transition: 'outline-color 0.1s' }}
                  >
                    <div className="row spread">
                      <span className="label">{FX_KEY_NAMES[id]}</span>
                      {edited && <span className="mono">{t('fx.buttons.edited')}</span>}
                    </div>
                    <select
                      className="input"
                      style={{ width: '100%' }}
                      disabled={macro || turbo !== null}
                      value={macro ? 'macro' : turbo !== null ? 'turbo' : value}
                      onChange={(e) => {
                        const v = Number(e.target.value)
                        setTurboEdits((prev) => {
                          const t = { ...prev }
                          delete t[id]
                          return t
                        })
                        setKeyEdits((prev) => {
                          const next = { ...prev }
                          if (cur.kind === 'key' && v === cur.target) delete next[id]
                          else next[id] = v
                          return next
                        })
                      }}
                    >
                      {macro && <option value="macro">{t('fx.buttons.macro')}</option>}
                      {turbo !== null && <option value="turbo">{fxFmt(t('fx.buttons.turboRepeats'), { key: FX_KEY_NAMES[id] })}</option>}
                      <option value={FX_KEY_DEFAULT}>{fxFmt(t('fx.buttons.default'), { key: FX_KEY_NAMES[id] })}</option>
                      {FX_KEY_ORDER.map((t) => (
                        <option key={t} value={t}>
                          {FX_KEY_NAMES[t]}
                        </option>
                      ))}
                    </select>
                    <div className="row" style={{ gap: 6 }}>
                      <select
                        className="input"
                        disabled={macro}
                        value={turbo === null ? 'off' : turbo.type === FX_TURBO_CLICK ? 'click' : 'press'}
                        onChange={(e) => {
                          const v = e.target.value
                          setTurbo(v === 'off' ? null : { type: v === 'click' ? FX_TURBO_CLICK : FX_TURBO_PRESS, frequency: turbo?.frequency ?? orig?.frequency ?? 8 })
                        }}
                      >
                        <option value="off">{t('fx.buttons.turboOff')}</option>
                        <option value="press">{t('fx.buttons.turboPress')}</option>
                        <option value="click">{t('fx.buttons.turboClick')}</option>
                      </select>
                      {turbo !== null && (
                        <input
                          type="number"
                          className="input mono"
                          style={{ width: 64 }}
                          min={FX_TURBO_MIN}
                          max={FX_TURBO_MAX}
                          step={1}
                          value={turbo.frequency}
                          title={t('fx.buttons.freq')}
                          onChange={(e) => {
                            const f = Math.round(Number(e.target.value))
                            if (Number.isFinite(f)) setTurbo({ ...turbo, frequency: Math.max(FX_TURBO_MIN, Math.min(FX_TURBO_MAX, f)) })
                          }}
                        />
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

    </>
  )
}

export function FxDevice({ fx, info }: { fx: Flydigi; info?: FdV1Info | null }): JSX.Element | null {
  const t = useT()
  const { snap, vib, setVib, setMotor, triggers, setTriggers, motion, setMotion, busy, rate, mode, pollingRate, toXInput, leaveXInput, setLeaveXInput, settings, sentOnly, setting, pending, stage, applySettings } = fx
  if (!snap || !vib || !triggers || !motion) return null
  const setGyro = (p: Partial<FxMotion>): void => setMotion({ ...motion, ...p })
  return (
    <>
          <div className="card" style={{ marginTop: 16 }}>
            <h3>{t('fx.trig.title')}</h3>
            <div className="hint" style={{ margin: '4px 0 8px' }}>
              {t('fx.trig.hint')}
            </div>
            {(['left', 'right'] as const).map((side) => (
              <div key={side} className="stack" style={{ gap: 6, marginBottom: 10 }}>
                <span className="label">{side === 'left' ? t('fx.trig.left') : t('fx.trig.right')}</span>
                <Num label={t('fx.trig.start')} value={triggers[side].zero} min={0} max={255} onChange={(v) => setTriggers({ ...triggers, [side]: fxTriggerRange(triggers[side], v, triggers[side].end) })} />
                <Num label={t('fx.trig.end')} value={triggers[side].end} min={0} max={255} onChange={(v) => setTriggers({ ...triggers, [side]: fxTriggerRange(triggers[side], triggers[side].zero, v) })} />
              </div>
            ))}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h3>{t('fx.gyro.title')}</h3>
            <div className="hint" style={{ margin: '4px 0 8px' }}>
              {t('fx.gyro.hint')}
            </div>
            <label style={{ display: 'block', maxWidth: 360 }}>
              <span className="label">{t('fx.gyro.mapping')}</span>
              <select
                className="input"
                style={{ width: '100%' }}
                value={motion.mapping}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  setGyro({ mapping: v, ...(v === FX_MOTION_RIGHT ? { racer: 0 } : {}) })
                }}
              >
                <option value={FX_MOTION_OFF}>{t('fx.gyro.off')}</option>
                <option value={FX_MOTION_LEFT}>{t('fx.leftStick')}</option>
                <option value={FX_MOTION_RIGHT}>{t('fx.rightStick')}</option>
                {![FX_MOTION_OFF, FX_MOTION_LEFT, FX_MOTION_RIGHT].includes(motion.mapping) && <option value={motion.mapping}>{fxFmt(t('fx.gyro.otherMapping'), { n: motion.mapping })}</option>}
              </select>
            </label>
            {motion.mapping !== FX_MOTION_OFF && (
              <div className="stack" style={{ gap: 8, marginTop: 10, maxWidth: 360 }}>
                <label style={{ display: 'block' }}>
                  <span className="label">{t('fx.gyro.key')}</span>
                  <select className="input" style={{ width: '100%' }} value={motion.enableKey} onChange={(e) => setGyro({ enableKey: Number(e.target.value) })}>
                    <option value={FX_KEY_DEFAULT}>{t('fx.gyro.none')}</option>
                    {FX_KEY_ORDER.map((id) => (
                      <option key={id} value={id}>
                        {FX_KEY_NAMES[id]}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ display: 'block' }}>
                  <span className="label">{t('fx.gyro.activation')}</span>
                  <select className="input" style={{ width: '100%' }} value={motion.enableType} onChange={(e) => setGyro({ enableType: Number(e.target.value) })}>
                    <option value={FX_MOTION_PRESS}>{t('fx.gyro.press')}</option>
                    <option value={FX_MOTION_CLICK}>{t('fx.gyro.click')}</option>
                    {![FX_MOTION_CLICK, FX_MOTION_PRESS].includes(motion.enableType) && <option value={motion.enableType}>{fxFmt(t('fx.gyro.otherActivation'), { n: motion.enableType })}</option>}
                  </select>
                </label>
                <Num label={t('fx.gyro.sensitivity')} value={motion.sensitivity} min={0} max={100} onChange={(v) => setGyro({ sensitivity: v, sensitivityY: v })} />
                <Num label={t('fx.gyro.deadZone')} value={motion.deadZone} min={0} max={100} onChange={(v) => setGyro({ deadZone: v })} />
                {motion.mapping === FX_MOTION_LEFT && (
                  <label className="row" style={{ gap: 8 }}>
                    <input type="checkbox" checked={motion.racer === 1} onChange={(e) => setGyro({ racer: e.target.checked ? 1 : 0 })} />
                    <span>{t('fx.gyro.racer')}</span>
                  </label>
                )}
              </div>
            )}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h3>{t('fx.vib.title')}</h3>
            <label className="row" style={{ gap: 8, margin: '4px 0 8px' }}>
              <input type="checkbox" checked={vib.enabled} onChange={(e) => setVib({ ...vib, enabled: e.target.checked })} />
              <span>{t('fx.vib.enabled')}</span>
            </label>
            {(['left', 'right'] as const).map((side) => (
              <div key={side} className="stack" style={{ gap: 6, marginBottom: 10 }}>
                <span className="label">{side === 'left' ? t('fx.vib.left') : t('fx.vib.right')}</span>
                <Num label={t('fx.vib.strength')} value={vib[side].scale} min={0} max={100} onChange={(v) => setMotor(side, { scale: v })} />
                <Num label={t('fx.vib.min')} value={vib[side].min} min={0} max={255} onChange={(v) => setMotor(side, { min: Math.min(v, vib[side].max) })} />
                <Num label={t('fx.vib.max')} value={vib[side].max} min={0} max={255} onChange={(v) => setMotor(side, { max: Math.max(v, vib[side].min) })} />
              </div>
            ))}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
          <h3>{t('fx.poll.title')}</h3>
          <div className="hint" style={{ margin: '4px 0 8px' }}>
            {t('fx.poll.hint')}
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {FX_REPORT_RATES.map((r) => (
              <button key={r.code} className={`choice-btn${rate === r.code ? ' active' : ''}`} disabled={busy} onClick={() => void pollingRate(r.code)}>
                {r.hz} Hz
              </button>
            ))}
            <button className="btn ghost sm" disabled={busy} onClick={() => void pollingRate(null)}>
              {t('fx.poll.check')}
            </button>
            <span className="mono" style={{ alignSelf: 'center' }}>{rate === null ? t('fx.poll.notChecked') : `${fxHzFromReportRate(rate) ?? '?'} Hz`}</span>
          </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h3>{t('fx.settings.title')}</h3>
            <div className="hint" style={{ margin: '4px 0 8px' }}>
              {t('fx.settings.hint')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
              <label style={{ display: 'block' }} title={t('fx.settings.sleepTip')}>
                <span className="label">
                  {t('fx.settings.sleep')} <span aria-hidden style={{ opacity: 0.6 }}>ⓘ</span>
                </span>
                <select
                  className="input"
                  style={{ width: '100%' }}
                  disabled={busy}
                  value={settings.sleepMinutes ?? ''}
                  onChange={(e) => void setting('sleep', Number(e.target.value))}
                >
                  {settings.sleepMinutes === undefined && <option value="">{t('fx.settings.notRead')}</option>}
                  {[0, 1, 5, 15, 60, 180].map((m) => (
                    <option key={m} value={m}>
                      {m === 0 ? t('fx.settings.never') : m >= 60 && m % 60 === 0 ? fxFmt(t('fx.settings.hours'), { n: m / 60 }) : fxFmt(t('fx.settings.minutes'), { n: m })}
                    </option>
                  ))}
                  {settings.sleepMinutes !== undefined && ![0, 1, 5, 15, 60, 180].includes(settings.sleepMinutes) && (
                    <option value={settings.sleepMinutes}>{fxFmt(t('fx.settings.minutes'), { n: settings.sleepMinutes })}</option>
                  )}
                </select>
              </label>
              {(
                [
                  ['quickSwitch', 'quickSwitchOn', 'fx.settings.quickSwitch', 'fx.settings.quickSwitchTip'],
                  ['stickDebounce', 'stickDebounceOn', 'fx.settings.stickDebounce', 'fx.settings.stickDebounceTip'],
                  ['autoCalibration', 'autoCalibrationOn', 'fx.settings.autoCalibration', 'fx.settings.autoCalibrationTip'],
                  ['rebound', 'reboundOn', 'fx.settings.rebound', 'fx.settings.reboundTip'],
                  ['gyroDebounce', 'gyroDebounceOn', 'fx.settings.gyroDebounce', 'fx.settings.gyroDebounceTip']
                ] as const
              ).map(([kind, key, label, tip]) => {
                const staged = kind === 'quickSwitch' ? undefined : pending[kind]
                const v = staged ?? settings[key]
                return (
                  <label key={kind} style={{ display: 'block' }} title={t(tip)}>
                    <span className="row spread">
                      <span className="label">
                        {t(label)} <span aria-hidden style={{ opacity: 0.6 }}>ⓘ</span>
                      </span>
                      {staged !== undefined ? (
                        <span className="mono" title={t('fx.settings.pendingTip')}>{t('fx.settings.pendingTag')}</span>
                      ) : sentOnly.includes(kind) && <span className="mono" title={t('fx.settings.sentTip')}>{t('fx.settings.sentTag')}</span>}
                    </span>
                    <select className="input" style={{ width: '100%' }} disabled={busy} value={v === undefined ? '' : v ? 'on' : 'off'} onChange={(e) => (kind === 'quickSwitch' ? void setting(kind, e.target.value === 'on') : stage(kind, e.target.value === 'on'))}>
                      {v === undefined && <option value="">{t('fx.settings.notRead')}</option>}
                      <option value="on">{t('fx.settings.on')}</option>
                      <option value="off">{t('fx.settings.off')}</option>
                    </select>
                  </label>
                )
              })}
            </div>
            <div className="row" style={{ gap: 8, marginTop: 10 }}>
              <button type="button" className="btn" disabled={busy || Object.keys(pending).length === 0} title={t('fx.settings.applyTip')} onClick={() => void applySettings()}>
                {t('fx.settings.apply')}
              </button>
            </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h3>{t('fx.mode.title')}</h3>
            <div className="hint" style={{ margin: '4px 0 8px' }}>
              {t('fx.mode.hint')}
            </div>
            {info && (
              <div className="mono" style={{ margin: '0 0 8px' }} title={t('fx.info.note')}>
                {t('fx.card.firmware')} {info.firmwareText}
                {info.connection !== 'unknown' ? ` · ${t(info.connection === 'wired' ? 'fx.info.wired' : 'fx.info.wireless')}` : ''}
              </div>
            )}
            <div className="row" style={{ gap: 8 }}>
              {mode === 'dinput' && (
                <button className="btn ghost" disabled={busy} onClick={() => void toXInput()}>
                  {t('fx.mode.toXInput')}
                </button>
              )}
              <span className="mono" style={{ alignSelf: 'center' }}>{mode === 'dinput' ? t('fx.mode.dinput') : mode === 'xinput' ? t('fx.mode.xinput') : t('fx.mode.none')}</span>
            </div>
            <label className="row" style={{ gap: 8, marginTop: 10, alignItems: 'center' }} title={t('fx.mode.leaveTip')}>
              <input type="checkbox" checked={leaveXInput} onChange={(e) => void setLeaveXInput(e.target.checked)} />
              <span>{t('fx.mode.leave')}</span>
            </label>
          </div>
    </>
  )
}

export function FxProfiles({ fx }: { fx: Flydigi }): JSX.Element | null {
  const t = useT()
  const { snap, busy, activate, selectSlot, backups, backupNow, restore, save, setSave } = fx
  if (!snap) return null
  return (
    <>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>{t('fx.slots.title')}</h3>
        <div className="hint" style={{ margin: '4px 0 8px' }}>
          {fxFmt(t('fx.slots.hint'), { n: Math.max(snap.cfgCount, 1) })}
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {Array.from({ length: Math.max(snap.cfgCount, 1) }, (_, i) => (
            <button key={i} className={`choice-btn${snap.cfgId === i ? ' active' : ''}`} disabled={busy} onClick={() => void selectSlot(i)} title={i === snap.activeCfgId ? t('fx.top.slotRunning') : undefined}>
              {fxFmt(t('fx.slots.config'), { n: i + 1 })}{i === snap.activeCfgId ? ' •' : ''}
            </button>
          ))}
          {snap.cfgId !== snap.activeCfgId && (
            <button className="btn" disabled={busy} onClick={() => void activate()}>
              {t('fx.slots.makeActive')}
            </button>
          )}
          <span className="mono" style={{ alignSelf: 'center' }}>{fxFmt(t('fx.slots.dataVersion'), { v: '0x' + snap.dataVersion.toString(16) })}</span>
        </div>
        <label className="row" style={{ gap: 6, marginTop: 10 }}>
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
          <span>{t('fx.slots.save')}{snap.cfgId !== snap.activeCfgId ? t('fx.slots.saveLive') : ''}</span>
        </label>
      </div>
          <div className="card" style={{ marginTop: 16 }}>
            <h3>{t('fx.backups.title')}</h3>
            <div className="hint" style={{ margin: '4px 0 8px' }}>
              {t('fx.backups.hint')}
            </div>
            <button className="btn ghost sm" disabled={busy} onClick={() => void backupNow()}>
              {fxFmt(t('fx.backups.now'), { n: snap.cfgId + 1 })}
            </button>
            {backups.length === 0 ? (
              <div className="hint" style={{ marginTop: 8 }}>{t('fx.backups.none')}</div>
            ) : (
              <div className="stack" style={{ gap: 4, marginTop: 8, maxHeight: 220, overflowY: 'auto' }}>
                {backups.map((b) => (
                  <div key={b.name} className="row spread" style={{ gap: 8 }}>
                    <span className="mono">
                      {fxFmt(t('fx.slots.config'), { n: b.cfgId + 1 })} · {new Date(b.time).toLocaleString()}
                    </span>
                    <button className="btn ghost sm" disabled={busy} onClick={() => void restore(b)}>
                      {t('fx.backups.restore')}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

      <FlydigiSteam fx={fx} />
    </>
  )
}
