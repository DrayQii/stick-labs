import type { JSX } from 'react'
import direwolf4 from './assets/direwolf4.png'

/** Connect card for the Direwolf 4: fills the whole content area, product photo on the right. Battery is shown only once the app can read it. */
export function FlydigiCard(props: {
  mode: 'DInput' | 'XInput'
  busy: boolean
  batteryPercent?: number | null
  onConnect: () => void
}): JSX.Element {
  const { mode, busy, batteryPercent = null, onConnect } = props
  const pct = batteryPercent === null ? null : Math.max(0, Math.min(100, batteryPercent))
  return (
    <button
      type="button"
      className="fx-card"
      disabled={busy}
      onClick={onConnect}
      title={mode === 'XInput' ? 'The pad is in XInput mode: connecting switches it to DInput (Windows asks permission once)' : undefined}
    >
      <span className="fx-card-body">
        <span className="fx-card-name">Flydigi Direwolf 4</span>
        <span className="fx-card-row">
          <span className="pill accent">{mode} mode</span>
          <span className="fx-battery" title={pct === null ? 'Battery level is not readable over USB yet' : `${pct}%`}>
            <span className="fx-battery-bar"><span className="fx-battery-fill" style={{ width: `${pct ?? 0}%` }} /></span>
            <span className="fx-battery-text">{pct === null ? 'Battery n/a' : `${pct}%`}</span>
          </span>
        </span>
        <span className="fx-card-cta">{busy ? 'Working…' : mode === 'XInput' ? 'Switch to DInput and connect' : 'Connect'}</span>
      </span>
      <span className="fx-card-pic">
        <img src={direwolf4} alt="Flydigi Direwolf 4 controller" draggable={false} />
      </span>
    </button>
  )
}
