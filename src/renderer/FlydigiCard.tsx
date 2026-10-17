import type { JSX } from 'react'
import direwolf4 from './assets/direwolf4.png'

/** Connect card for the Direwolf 4, drawn inside the "Connect a controller" panel. Battery is shown only once the app can read it. */
export function FlydigiCard(props: {
  mode: 'DInput' | 'XInput'
  busy: boolean
  batteryPercent?: number | null
  charging?: boolean
  /** Raw get-info reply from the pad, shown while the battery byte is still unconfirmed. */
  probeHex?: string | null
  onConnect: () => void
  /** XInput mode only: switch through Space Station's driver instead of the pad's FN + D-pad Left combo. */
  onDriverSwitch?: () => void
}): JSX.Element {
  const { mode, busy, batteryPercent = null, charging = false, probeHex = null, onConnect, onDriverSwitch } = props
  const xinput = mode === 'XInput'
  const pct = batteryPercent === null ? null : Math.max(0, Math.min(100, batteryPercent))
  const Root = xinput ? 'div' : 'button'
  return (
    <Root
      {...(xinput ? { role: 'group' } : { type: 'button' as const, disabled: busy, onClick: onConnect })}
      className="fx-card"
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
              <span className="fx-battery-bar"><span className="fx-battery-fill" style={{ width: `${pct ?? 0}%` }} data-charging={charging || undefined} /></span>
              {pct === null ? 'N/A' : `${pct}%${charging ? ' CHG' : ''}`}
            </span>
          </span>
        </span>
        {pct === null && probeHex && <span className="fx-probe">Reply {probeHex}</span>}
        {xinput ? (
          <span className="fx-card-cta" style={{ display: 'block' }}>
            <span style={{ display: 'block' }}>Hold FN + D-pad Left on the pad to switch to DInput. It connects automatically once it switches.</span>
            {onDriverSwitch && (
              <button type="button" className="btn ghost sm" style={{ marginTop: 8 }} disabled={busy} onClick={onDriverSwitch} title="Uses Flydigi Space Station's driver (it must be installed but not running); Windows asks for permission once">
                {busy ? 'Working' : 'Or switch with Space Station’s driver'}
              </button>
            )}
          </span>
        ) : (
          <span className="fx-card-cta">
            <span>{busy ? 'Working' : 'Connect'}</span>
            <span className="fx-card-arrows" aria-hidden>&gt;&gt;&gt;</span>
          </span>
        )}
      </span>
      <span className="fx-card-pic">
        <span className="fx-corner tl" aria-hidden />
        <span className="fx-corner tr" aria-hidden />
        <span className="fx-corner bl" aria-hidden />
        <span className="fx-corner br" aria-hidden />
        <span className="fx-scan" aria-hidden />
        <img src={direwolf4} alt="Flydigi Direwolf 4 controller" draggable={false} />
      </span>
    </Root>
  )
}
