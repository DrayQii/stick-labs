/**
 * Flydigi Direwolf 4 (XInput mode) tuning — vibration and stick centre.
 *
 * Talks to Space Station's Xbox 360 filter driver through the main-process
 * sidecar (docs/flydigi.md). The app must run elevated with Space Station and
 * its service closed. Every write is read back by the main process and rolled
 * back on mismatch.
 */
import { useState } from 'react'
import type { FxSnapshot, FxVibration } from '@shared/flydigi-xinput'
import { api } from './api'

const sc = (b: number): number => (b > 127 ? b - 256 : b)

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
  const [save, setSave] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const adopt = (s: FxSnapshot): void => {
    setSnap(s)
    setVib(s.vibration)
    setLeft(sc(s.sticks.left.center))
    setRight(sc(s.sticks.right.center))
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
    if (!snap || !vib) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await api().flydigiXWrite({
        vibration: vib,
        leftCenter: left & 0xff,
        rightCenter: right & 0xff,
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

      {snap && vib && (
        <div className="stack" style={{ gap: 14, marginTop: 16 }}>
          <div>
            <h4>Sticks</h4>
            <div className="hint" style={{ margin: '4px 0 8px' }}>
              Centre is the stored byte Space Station calls <i>center</i> (signed; the scale is not decoded yet). The curve itself is not editable here.
            </div>
            <Num label="Left stick centre" value={left} min={-127} max={127} onChange={setLeft} />
            <Num label="Right stick centre" value={right} min={-127} max={127} onChange={setRight} />
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
