/**
 * Flydigi Direwolf 4 tab content for the main app: one section per tab (Sticks, Buttons, Device,
 * Profiles). State and actions come from useFlydigi; the topbar owns slots and Write.
 */
import { FX_REPORT_RATES, fxHzFromReportRate, FX_KEY_DEFAULT, FX_KEY_NAMES, FX_KEY_ORDER, FX_TURBO_CLICK, FX_TURBO_MAX, FX_TURBO_MIN, FX_TURBO_PRESS, fxTriggerRange, type FxTurbo } from '@shared/flydigi-xinput'
import FlydigiCurveDesigner from './FlydigiCurveDesigner'
import FlydigiLiveView from './FlydigiLiveView'
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
  const { snap, curves, setCurves, left, right, setDeadzone, setEdge, sc } = fx
  if (!snap || !curves) return null
  return (
    <>
          <div className="card" style={{ marginTop: 16 }}>
        <h3>Live input</h3>
        <div className="hint" style={{ margin: '4px 0 8px' }}>
          What the system sees from the pad right now (stick position, triggers, buttons). Handy for checking a curve or deadzone after writing. Read-only; the pad&apos;s own output, after its curve.
        </div>
        <FlydigiLiveView />
          </div>
          <div className="card" style={{ marginTop: 16 }}>
            <h3>Sticks</h3>
            <div className="hint" style={{ margin: '4px 0 8px' }}>
              Same number as Space Station&apos;s Center slider (-100 Offset to 100 Dead zone); Edge is the outer end of the same range (negative lowers the maximum output, positive reaches full output earlier). They set the stick&apos;s centre byte and regenerates the curve exactly as Space Station does (within 1 on a few points). Fine-tune the curve below if you want something else; moving the deadzone again regenerates it.
            </div>
            <Num label="Left stick deadzone" value={left} min={-100} max={100} onChange={(d) => setDeadzone('left', d)} />
            <Num label="Right stick deadzone" value={right} min={-100} max={100} onChange={(d) => setDeadzone('right', d)} />
            <Num label="Left stick edge" value={sc(curves.left.edge)} min={-100} max={100} onChange={(e) => setEdge('left', e)} />
            <Num label="Right stick edge" value={sc(curves.right.edge)} min={-100} max={100} onChange={(e) => setEdge('right', e)} />
            <div style={{ height: 10 }} />
            <h4 style={{ marginTop: 12 }}>Response curves</h4>
            <div className="hint" style={{ margin: '4px 0 8px' }}>
              Output height at nine evenly spaced stick positions (0% to 100% of travel). Drag the points, type values, or apply a preset. Moving a deadzone slider above regenerates that stick&apos;s curve.
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16 }}>
              <FlydigiCurveDesigner
                title="Left stick curve"
                curve={curves.left}
                onChange={(c) => setCurves({ ...curves, left: c })}
                onCopyToOther={() => setCurves({ ...curves, right: { ...curves.left } })}
                otherLabel="right"
              />
              <FlydigiCurveDesigner
                title="Right stick curve"
                curve={curves.right}
                onChange={(c) => setCurves({ ...curves, right: c })}
                onCopyToOther={() => setCurves({ ...curves, left: { ...curves.right } })}
                otherLabel="left"
              />
            </div>
          </div>

    </>
  )
}

export function FxButtons({ fx }: { fx: Flydigi }): JSX.Element | null {
  const { snap, keyEdits, setKeyEdits, turboEdits, setTurboEdits } = fx
  if (!snap) return null
  return (
    <>
          <div className="card" style={{ marginTop: 16 }}>
            <h3>Buttons</h3>
            <div className="hint" style={{ margin: '4px 0 8px' }}>
              Pick what each button sends. &quot;Default&quot; means no remap. Turbo makes a button repeat itself: Press repeats while you hold it, Click toggles repeating on each press (Space Station&apos;s names); the number is its frequency (Space Station used 8 and 15). Changes are written with Write to controller. Macro buttons are shown but must be edited in Space Station.
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
                  <div key={id} className="stack" style={{ gap: 4 }}>
                    <div className="row spread">
                      <span className="label">{FX_KEY_NAMES[id]}</span>
                      {edited && <span className="mono">edited</span>}
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
                      {macro && <option value="macro">Macro (Space Station)</option>}
                      {turbo !== null && <option value="turbo">Turbo: repeats {FX_KEY_NAMES[id]}</option>}
                      <option value={FX_KEY_DEFAULT}>Default ({FX_KEY_NAMES[id]})</option>
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
                        <option value="off">Turbo off</option>
                        <option value="press">Turbo: Press</option>
                        <option value="click">Turbo: Click</option>
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
                          title="Repeat frequency"
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

export function FxDevice({ fx }: { fx: Flydigi }): JSX.Element | null {
  const { snap, vib, setVib, setMotor, triggers, setTriggers, busy, rate, mode, pollingRate, toXInput } = fx
  if (!snap || !vib || !triggers) return null
  return (
    <>
          <div className="card" style={{ marginTop: 16 }}>
            <h3>Triggers</h3>
            <div className="hint" style={{ margin: '4px 0 8px' }}>
              Same numbers as Space Station&apos;s trigger Start and End sliders (0 to 255; the stock range is 0 to 255). The two curve points follow them the way Space Station sets them.
            </div>
            {(['left', 'right'] as const).map((side) => (
              <div key={side} className="stack" style={{ gap: 6, marginBottom: 10 }}>
                <span className="label">{side === 'left' ? 'Left trigger (LT)' : 'Right trigger (RT)'}</span>
                <Num label="Start" value={triggers[side].zero} min={0} max={255} onChange={(v) => setTriggers({ ...triggers, [side]: fxTriggerRange(triggers[side], v, triggers[side].end) })} />
                <Num label="End" value={triggers[side].end} min={0} max={255} onChange={(v) => setTriggers({ ...triggers, [side]: fxTriggerRange(triggers[side], triggers[side].zero, v) })} />
              </div>
            ))}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h3>Vibration</h3>
            <label className="row" style={{ gap: 8, margin: '4px 0 8px' }}>
              <input type="checkbox" checked={vib.enabled} onChange={(e) => setVib({ ...vib, enabled: e.target.checked })} />
              <span>Vibration enabled</span>
            </label>
            {(['left', 'right'] as const).map((side) => (
              <div key={side} className="stack" style={{ gap: 6, marginBottom: 10 }}>
                <span className="label">{side === 'left' ? 'Left motor (heavy)' : 'Right motor (light)'}</span>
                <Num label="Strength" value={vib[side].scale} min={0} max={100} onChange={(v) => setMotor(side, { scale: v })} />
                <Num label="Minimum" value={vib[side].min} min={0} max={255} onChange={(v) => setMotor(side, { min: Math.min(v, vib[side].max) })} />
                <Num label="Maximum" value={vib[side].max} min={0} max={255} onChange={(v) => setMotor(side, { max: Math.max(v, vib[side].min) })} />
              </div>
            ))}
          </div>

          <div className="card" style={{ marginTop: 16 }}>
          <h3>Polling rate</h3>
          <div className="hint" style={{ margin: '4px 0 8px' }}>
            How often the pad reports to the PC. The Direwolf only exposes this in XInput mode, so changing it switches the pad to XInput and back through the Flydigi driver (one administrator step, about 20 seconds). Keep Flydigi Space Station closed.
          </div>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {FX_REPORT_RATES.map((r) => (
              <button key={r.code} className={`choice-btn${rate === r.code ? ' active' : ''}`} disabled={busy} onClick={() => void pollingRate(r.code)}>
                {r.hz} Hz
              </button>
            ))}
            <button className="btn ghost sm" disabled={busy} onClick={() => void pollingRate(null)}>
              Check current
            </button>
            <span className="mono" style={{ alignSelf: 'center' }}>{rate === null ? 'not checked yet' : `${fxHzFromReportRate(rate) ?? '?'} Hz`}</span>
          </div>
          </div>

          <div className="card" style={{ marginTop: 16 }}>
            <h3>Pad mode</h3>
            <div className="hint" style={{ margin: '4px 0 8px' }}>
              Stick Labs configures the pad in DInput mode. Switch to XInput to give games an Xbox controller again; the pad returns here when you click its button in the sidebar (or launch Space Station, which also switches it back).
            </div>
            <div className="row" style={{ gap: 8 }}>
              {mode === 'dinput' && (
                <button className="btn ghost" disabled={busy} onClick={() => void toXInput()}>
                  Switch to XInput
                </button>
              )}
              <span className="mono" style={{ alignSelf: 'center' }}>{mode === 'dinput' ? 'DInput mode' : mode === 'xinput' ? 'XInput mode' : 'pad not found'}</span>
            </div>
          </div>
    </>
  )
}

export function FxProfiles({ fx }: { fx: Flydigi }): JSX.Element | null {
  const { snap, busy, activate, selectSlot, backups, backupNow, restore, save, setSave } = fx
  if (!snap) return null
  return (
    <>
      <div className="card" style={{ marginTop: 16 }}>
        <h3>Config slots</h3>
        <div className="hint" style={{ margin: '4px 0 8px' }}>
          The pad has {Math.max(snap.cfgCount, 1)} onboard slots (Space Station&apos;s 配置1…{Math.max(snap.cfgCount, 1)}); • marks the one it is running. Switching also works from P1…P4 in the top bar.
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {Array.from({ length: Math.max(snap.cfgCount, 1) }, (_, i) => (
            <button key={i} className={`choice-btn${snap.cfgId === i ? ' active' : ''}`} disabled={busy} onClick={() => void selectSlot(i)} title={i === snap.activeCfgId ? 'The pad is running this config' : undefined}>
              Config {i + 1}{i === snap.activeCfgId ? ' •' : ''}
            </button>
          ))}
          {snap.cfgId !== snap.activeCfgId && (
            <button className="btn" disabled={busy} onClick={() => void activate()}>
              Make active
            </button>
          )}
          <span className="mono" style={{ alignSelf: 'center' }}>data v{'0x' + snap.dataVersion.toString(16)}</span>
        </div>
        <label className="row" style={{ gap: 6, marginTop: 10 }}>
          <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
          <span>Save to pad when writing (survives replug){snap.cfgId !== snap.activeCfgId ? ' — only for the active config; this slot is written live only' : ''}</span>
        </label>
      </div>
          <div className="card" style={{ marginTop: 16 }}>
            <h3>Backups</h3>
            <div className="hint" style={{ margin: '4px 0 8px' }}>
              A copy of the slot is saved before every write and restore. Restoring puts a backup back into the slot it came from (this follows the Save to pad option above). Files live in Stick Labs&apos; data folder under flydigi-backups.
            </div>
            <button className="btn ghost sm" disabled={busy} onClick={() => void backupNow()}>
              Back up config {snap.cfgId + 1} now
            </button>
            {backups.length === 0 ? (
              <div className="hint" style={{ marginTop: 8 }}>No backups yet.</div>
            ) : (
              <div className="stack" style={{ gap: 4, marginTop: 8, maxHeight: 220, overflowY: 'auto' }}>
                {backups.map((b) => (
                  <div key={b.name} className="row spread" style={{ gap: 8 }}>
                    <span className="mono">
                      Config {b.cfgId + 1} · {new Date(b.time).toLocaleString()}
                    </span>
                    <button className="btn ghost sm" disabled={busy} onClick={() => void restore(b)}>
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

    </>
  )
}
