/**
 * Flydigi Direwolf 4 (XInput mode) tuning — vibration and stick centre.
 *
 * Talks to Space Station's Xbox 360 filter driver through the main-process
 * sidecar (docs/flydigi.md). The app must run elevated with Space Station and
 * its service closed. Every write is read back by the main process and rolled
 * back on mismatch.
 */
import { useState } from 'react'
import { FX_CURVE_CUSTOM, FX_CURVE_DEFAULT, FX_CURVE_DEFAULT_POINTS, fxDeadzonePoints, type FxCurve, type FxSnapshot, type FxVibration } from '@shared/flydigi-xinput'
import { api } from './api'

const sc = (b: number): number => (b > 127 ? b - 256 : b)

/** Nine-point response curve: type, circularity and a draggable-by-slider preview. */
function CurveEditor(props: { title: string; curve: FxCurve; onChange: (c: FxCurve) => void }): JSX.Element {
  const { curve, onChange } = props
  const W = 220
  const H = 120
  const top = 255
  const pts = curve.points.map((v, i) => `${(i / 8) * W},${H - (Math.min(v, top) / top) * H}`).join(' ')
  const setPoint = (i: number, v: number): void =>
    onChange({ ...curve, type: FX_CURVE_CUSTOM, points: curve.points.map((p, k) => (k === i ? v : p)) })
  return (
    <div className="stack" style={{ gap: 6, marginBottom: 14 }}>
      <span className="label">{props.title}</span>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <select className="input" value={curve.type === FX_CURVE_DEFAULT ? 'default' : 'custom'} onChange={(e) => onChange(e.target.value === 'default' ? { ...curve, type: FX_CURVE_DEFAULT, points: [...FX_CURVE_DEFAULT_POINTS] } : { ...curve, type: FX_CURVE_CUSTOM })}>
          <option value="default">Default ramp</option>
          <option value="custom">Custom curve</option>
        </select>
        <select className="input" value={curve.circularity} onChange={(e) => onChange({ ...curve, circularity: Number(e.target.value) })}>
          <option value={1}>Circular</option>
          <option value={0}>Rectangle</option>
        </select>
        <button className="btn ghost sm" onClick={() => onChange({ ...curve, type: FX_CURVE_DEFAULT, points: [...FX_CURVE_DEFAULT_POINTS] })}>
          Reset to default
        </button>
      </div>
      <svg width={W} height={H} style={{ background: 'var(--bg-2, #111)', border: '1px solid var(--line-2, #333)', borderRadius: 4 }}>
        <polyline points={pts} fill="none" stroke="var(--accent, #e44)" strokeWidth={2} />
      </svg>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
        {curve.points.map((v, i) => (
          <label key={i} style={{ display: 'block' }}>
            <div className="row spread">
              <span className="label">P{i + 1}</span>
              <span className="mono">{v}</span>
            </div>
            <input type="range" className="input" style={{ width: '100%' }} min={0} max={255} step={1} value={v} onChange={(e) => setPoint(i, Number(e.target.value))} />
          </label>
        ))}
      </div>
    </div>
  )
}

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

export default function FlydigiPanel(): JSX.Element {
  const [snap, setSnap] = useState<FxSnapshot | null>(null)
  const [vib, setVib] = useState<FxVibration | null>(null)
  const [left, setLeft] = useState(0)
  const [right, setRight] = useState(0)
  const [curves, setCurves] = useState<{ left: FxCurve; right: FxCurve } | null>(null)
  const [save, setSave] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const adopt = (s: FxSnapshot): void => {
    setSnap(s)
    setVib(s.vibration)
    setLeft(Math.max(0, sc(s.sticks.left.center)))
    setRight(Math.max(0, sc(s.sticks.right.center)))
    setCurves(s.curves)
  }

  async function load(): Promise<void> {
    setBusy(true)
    setMsg(null)
    try {
      adopt(await api().flydigiXRead())
      setMsg({ kind: 'ok', text: 'Read the live config from the pad.' })
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  async function apply(): Promise<void> {
    if (!snap || !vib || !curves) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await api().flydigiXWrite({
        vibration: vib,
        leftCenter: left & 0xff,
        rightCenter: right & 0xff,
        leftCurve: curves.left,
        rightCurve: curves.right,
        save
      })
      if (!r.verified) {
        setMsg({ kind: 'err', text: r.restored ? 'Readback mismatch — rolled back to the previous config.' : 'Readback mismatch and the rollback could not be confirmed. Re-read the pad.' })
      } else if (r.changedPacks === 0) {
        setMsg({ kind: 'ok', text: 'Nothing to change.' })
      } else {
        setMsg({ kind: 'ok', text: `Written and verified (${r.changedPacks} pack${r.changedPacks === 1 ? '' : 's'})${save ? (r.saved ? ', saved to the pad.' : ', but the save was not acknowledged.') : ' — live only, not saved.'}` })
      }
      adopt(await api().flydigiXRead())
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

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>Flydigi Direwolf 4</h3>
      <div className="hint" style={{ margin: '6px 0 12px' }}>
        XInput mode only. Run Stick Labs as Administrator and close Flydigi Space Station and its background service first — they hold the driver this uses.
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn" disabled={busy} onClick={() => void load()}>
          {snap ? 'Re-read pad' : 'Read pad'}
        </button>
        {snap && (
          <span className="mono" style={{ alignSelf: 'center' }}>
            config {snap.cfgId} · data v{'0x' + snap.dataVersion.toString(16)}
          </span>
        )}
      </div>

      {msg && (
        <div className="hint" style={{ marginTop: 10, color: msg.kind === 'err' ? 'var(--bad, #e66)' : 'var(--good, #6c6)' }}>
          {msg.text}
        </div>
      )}

      {snap && vib && curves && (
        <div className="stack" style={{ gap: 14, marginTop: 16 }}>
          <div>
            <h4>Sticks</h4>
            <div className="hint" style={{ margin: '4px 0 8px' }}>
              Same number as Space Station&apos;s deadzone slider. It sets the stick&apos;s centre byte and regenerates the curve exactly as Space Station does (within 1 on a few points). Fine-tune the curve below if you want something else; moving the deadzone again regenerates it.
            </div>
            <Num label="Left stick deadzone" value={left} min={0} max={100} onChange={(d) => setDeadzone('left', d)} />
            <Num label="Right stick deadzone" value={right} min={0} max={100} onChange={(d) => setDeadzone('right', d)} />
            <div style={{ height: 10 }} />
            <details style={{ marginTop: 6 }}>
              <summary className="label" style={{ cursor: 'pointer' }}>Advanced: raw curve points</summary>
            <CurveEditor title="Left stick curve" curve={curves.left} onChange={(c) => setCurves({ ...curves, left: c })} />
            <CurveEditor title="Right stick curve" curve={curves.right} onChange={(c) => setCurves({ ...curves, right: c })} />
            </details>
          </div>

          <div>
            <h4>Vibration</h4>
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

          <div className="row" style={{ gap: 12, alignItems: 'center' }}>
            <label className="row" style={{ gap: 6 }}>
              <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
              <span>Save to pad (survives replug)</span>
            </label>
            <button className="btn primary" disabled={busy} onClick={() => void apply()}>
              Apply
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
