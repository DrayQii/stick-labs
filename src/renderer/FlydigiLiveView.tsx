/**
 * Live stick / trigger / button view for the Direwolf, read from the system Gamepad API (the same
 * route the LeadJoy view uses): no HID handle is opened, so it can run beside the config session
 * and works in XInput and DInput mode alike. Axes default to the standard mapping (LX LY RX RY, LT/RT
 * as buttons 6/7); a pad in DInput mode reports a different layout, so each control can be pointed at
 * any axis (remembered in localStorage) while the raw axes are shown.
 */
import { useEffect, useRef, useState } from 'react'

/** Which gamepad axis (or trigger source) feeds each control. Triggers: 'b6'/'b7' = button value, 'aN' = axis N rescaled from -1..1. */
interface Mapping {
  lx: number
  ly: number
  rx: number
  ry: number
  lt: string
  rt: string
}
const STANDARD: Mapping = { lx: 0, ly: 1, rx: 2, ry: 3, lt: 'b6', rt: 'b7' }
const MAP_KEY = 'sticklab.flydigi.liveMap'
const loadMap = (): Mapping => {
  try {
    const m = JSON.parse(window.localStorage.getItem(MAP_KEY) ?? 'null') as Mapping | null
    if (m && [m.lx, m.ly, m.rx, m.ry].every((v) => Number.isInteger(v)) && typeof m.lt === 'string' && typeof m.rt === 'string') return m
  } catch {
    /* use the default */
  }
  return STANDARD
}

interface Live {
  id: string
  standard: boolean
  axes: number[]
  buttons: { pressed: boolean; value: number }[]
}

const R = 52
const BTN_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L3', 'R3', 'Up', 'Down', 'Left', 'Right', 'Home']

function Stick(props: { label: string; x: number; y: number }): JSX.Element {
  const { x, y } = props
  const mag = Math.min(1, Math.hypot(x, y))
  const size = R * 2 + 12
  return (
    <div className="stack" style={{ gap: 4, alignItems: 'center' }}>
      <span className="label">{props.label}</span>
      <svg width={size} height={size} viewBox={`${-R - 6} ${-R - 6} ${size} ${size}`} style={{ background: 'var(--bg-2, #111)', border: '1px solid var(--line-2, #333)', borderRadius: 4 }}>
        <circle r={R} fill="none" stroke="var(--line-2, #333)" />
        <line x1={-R} x2={R} stroke="var(--line-2, #333)" strokeWidth={0.6} />
        <line y1={-R} y2={R} stroke="var(--line-2, #333)" strokeWidth={0.6} />
        <line x2={x * R} y2={y * R} stroke="var(--accent, #f43f52)" strokeWidth={1} opacity={0.5} />
        <circle cx={x * R} cy={y * R} r={5} fill="var(--accent, #f43f52)" />
      </svg>
      <span className="mono" style={{ fontSize: 11 }}>
        x {x.toFixed(3)} · y {y.toFixed(3)} · {(mag * 100).toFixed(1)}%
      </span>
    </div>
  )
}

function Bar(props: { label: string; value: number }): JSX.Element {
  const v = Math.max(0, Math.min(1, props.value))
  return (
    <div className="stack" style={{ gap: 2, flex: 1, minWidth: 120 }}>
      <div className="row spread">
        <span className="label">{props.label}</span>
        <span className="mono" style={{ fontSize: 11 }}>{(v * 100).toFixed(1)}%</span>
      </div>
      <div style={{ height: 8, background: 'var(--bg-2, #111)', border: '1px solid var(--line-2, #333)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${v * 100}%`, height: '100%', background: 'var(--accent, #f43f52)' }} />
      </div>
    </div>
  )
}

export default function FlydigiLiveView(): JSX.Element {
  const [live, setLive] = useState<Live | null>(null)
  const raf = useRef(0)
  const [map, setMapState] = useState<Mapping>(loadMap)
  const setMap = (m: Mapping): void => {
    setMapState(m)
    try {
      window.localStorage.setItem(MAP_KEY, JSON.stringify(m))
    } catch {
      /* not remembered */
    }
  }

  useEffect(() => {
    const poll = (): void => {
      const pads = Array.from(navigator.getGamepads()).filter((p): p is Gamepad => !!p && p.connected)
      const pad = pads.find((p) => /flydigi|direwolf|04b4|360|xbox/i.test(p.id)) ?? pads[0] ?? null
      setLive(
        pad
          ? { id: pad.id, standard: pad.mapping === 'standard', axes: Array.from(pad.axes), buttons: pad.buttons.map((b) => ({ pressed: b.pressed, value: b.value })) }
          : null
      )
      raf.current = requestAnimationFrame(poll)
    }
    raf.current = requestAnimationFrame(poll)
    return () => cancelAnimationFrame(raf.current)
  }, [])

  if (!live) {
    return <div className="hint">No gamepad seen by the system. Plug the pad in and move a stick (the browser only reports a pad after its first input).</div>
  }
  const a = (i: number): number => live.axes[i] ?? 0
  const trig = (src: string): number => (src.startsWith('a') ? (a(Number(src.slice(1))) + 1) / 2 : (live.buttons[Number(src.slice(1))]?.value ?? 0))
  const axisOpts = live.axes.map((_, i) => (
    <option key={i} value={i}>
      axis {i}
    </option>
  ))
  const trigOpts = [
    ...live.buttons.map((_, i) => (
      <option key={`b${i}`} value={`b${i}`}>
        button {i}
      </option>
    )),
    ...live.axes.map((_, i) => (
      <option key={`a${i}`} value={`a${i}`}>
        axis {i}
      </option>
    ))
  ]
  const pick = (label: string, key: keyof Mapping, opts: JSX.Element[]): JSX.Element => (
    <label className="row" style={{ gap: 4 }}>
      <span className="label">{label}</span>
      <select
        className="input"
        value={map[key]}
        onChange={(e) => setMap({ ...map, [key]: key === 'lt' || key === 'rt' ? e.target.value : Number(e.target.value) })}
      >
        {opts}
      </select>
    </label>
  )
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="mono" style={{ fontSize: 11, opacity: 0.8 }}>
        {live.id} · {live.standard ? 'standard mapping' : 'non-standard mapping: axes below may not be LX/LY/RX/RY'} · {live.axes.length} axes
      </div>
      <div className="row" style={{ gap: 16, flexWrap: 'wrap' }}>
        <Stick label="Left stick" x={a(map.lx)} y={a(map.ly)} />
        <Stick label="Right stick" x={a(map.rx)} y={a(map.ry)} />
        <div className="stack" style={{ gap: 10, flex: 1, minWidth: 160 }}>
          <Bar label="LT" value={trig(map.lt)} />
          <Bar label="RT" value={trig(map.rt)} />
        </div>
      </div>
      <div className="mono" style={{ fontSize: 11, opacity: 0.8, wordBreak: 'break-all' }}>
        raw axes: {live.axes.map((v, i) => `${i}:${v.toFixed(2)}`).join('  ')}
      </div>
      <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
        {pick('LX', 'lx', axisOpts)}
        {pick('LY', 'ly', axisOpts)}
        {pick('RX', 'rx', axisOpts)}
        {pick('RY', 'ry', axisOpts)}
        {pick('LT', 'lt', trigOpts)}
        {pick('RT', 'rt', trigOpts)}
        <button className="btn ghost sm" onClick={() => setMap(STANDARD)}>
          Standard
        </button>
      </div>
      <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
        {live.buttons.map((b, i) => (
          <span key={i} className="mono" style={{ fontSize: 11, padding: '1px 6px', borderRadius: 3, border: '1px solid var(--line-2, #333)', background: b.pressed ? 'var(--accent, #f43f52)' : 'transparent', color: b.pressed ? '#fff' : 'inherit' }}>
            {BTN_NAMES[i] ?? `B${i}`}
          </span>
        ))}
      </div>
    </div>
  )
}
