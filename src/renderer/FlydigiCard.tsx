import type { JSX } from 'react'
import direwolf4 from './assets/direwolf4.png'

/** Connect card for the Direwolf 4, drawn inside the "Connect a controller" panel. Battery is shown only once the app can read it. */
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
        <span className="fx-card-brand">FLYDIGI<sup>®</sup></span>
        <span className="fx-card-name">Direwolf 4</span>
        <span className="fx-card-grid">
          <span className="fx-cell">
            <span className="fx-cell-k">Mode</span>
            <span className="fx-cell-v">[ {mode} ]</span>
          </span>
          <span className="fx-cell" title={pct === null ? 'Battery level is not readable over USB yet' : `${pct}%`}>
            <span className="fx-cell-k">Battery</span>
            <span className="fx-cell-v">
              <span className="fx-battery-bar"><span className="fx-battery-fill" style={{ width: `${pct ?? 0}%` }} /></span>
              {pct === null ? 'N/A' : `${pct}%`}
            </span>
          </span>
        </span>
        <span className="fx-card-cta">
          <span>{busy ? 'Working' : mode === 'XInput' ? 'Switch and connect' : 'Connect'}</span>
          <span className="fx-card-arrows" aria-hidden>&gt;&gt;&gt;</span>
        </span>
      </span>
      <span className="fx-card-pic">
        <span className="fx-corner tl" aria-hidden />
        <span className="fx-corner tr" aria-hidden />
        <span className="fx-corner bl" aria-hidden />
        <span className="fx-corner br" aria-hidden />
        <span className="fx-scan" aria-hidden />
        <img src={direwolf4} alt="Flydigi Direwolf 4 controller" draggable={false} />
      </span>
    </button>
  )
}
