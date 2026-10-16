import type { JSX } from 'react'

/** Simple line drawing of a gamepad, drawn with currentColor so it follows the theme. */
function PadPicture(): JSX.Element {
  return (
    <svg viewBox="0 0 160 100" width="150" height="94" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M52 22h56c10 0 16 4 20 14l14 38c3 9-3 16-11 16-6 0-10-3-14-9l-6-9H49l-6 9c-4 6-8 9-14 9-8 0-14-7-11-16l14-38c4-10 10-14 20-14z" />
      <path d="M52 22l4-8h12M108 22l-4-8H92" />
      <circle cx="54" cy="46" r="8" />
      <circle cx="98" cy="62" r="8" />
      <path d="M72 62h-8M68 58v8" />
      <circle cx="112" cy="40" r="2" fill="currentColor" />
      <circle cx="120" cy="46" r="2" fill="currentColor" />
      <circle cx="104" cy="46" r="2" fill="currentColor" />
      <circle cx="112" cy="52" r="2" fill="currentColor" />
    </svg>
  )
}

/** Connect card for the Direwolf 4: picture, name, mode and battery. Battery is shown only once the app can read it. */
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
      <span className="fx-card-pic"><PadPicture /></span>
      <span className="fx-card-body">
        <span className="fx-card-name">Flydigi Direwolf 4</span>
        <span className="fx-card-row">
          <span className="pill accent">{mode} mode</span>
          <span className="fx-battery" title={pct === null ? 'Battery level is not readable over USB yet' : `${pct}%`}>
            <span className="fx-battery-bar"><span className="fx-battery-fill" style={{ width: `${pct ?? 0}%` }} /></span>
            <span className="fx-battery-text">{pct === null ? 'Battery n/a' : `${pct}%`}</span>
          </span>
        </span>
        <span className="fx-card-cta">{busy ? 'Working…' : mode === 'XInput' ? 'Switch to DInput & connect' : 'Connect'}</span>
      </span>
    </button>
  )
}
