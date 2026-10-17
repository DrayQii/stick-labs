import type { JSX } from 'react'
import direwolf4 from './assets/direwolf4.png'
import { useT } from './i18n'

/** Connect card for the Direwolf 4, drawn inside the "Connect a controller" panel. Battery is shown only once the app can read it. */
export function FlydigiCard(props: {
  mode: 'DInput' | 'XInput'
  busy: boolean
  batteryPercent?: number | null
  charging?: boolean
  /** Raw get-info reply from the pad, shown while the battery byte is still unconfirmed. */
  probeHex?: string | null
  /** Firmware from the get-info reply: undefined hides the cell, null shows N/A. */
  firmware?: string | null
  connection?: 'wired' | 'wireless' | 'unknown'
  onConnect: () => void
  /** XInput mode only: switch through Space Station's driver instead of the pad's FN + D-pad Left combo. */
  onDriverSwitch?: () => void
}): JSX.Element {
  const { mode, busy, batteryPercent = null, charging = false, probeHex = null, firmware, connection = 'unknown', onConnect, onDriverSwitch } = props
  const t = useT()
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
            <span className="fx-cell-k">{t('fx.card.mode')}</span>
            <span className="fx-cell-v">[ {mode} ]</span>
          </span>
          <span className="fx-cell" title={pct === null ? t('fx.card.batteryTip') : `${pct}%`}>
            <span className="fx-cell-k">{t('fx.card.battery')}</span>
            <span className="fx-cell-v">
              <span className="fx-battery-bar"><span className="fx-battery-fill" style={{ width: `${pct ?? 0}%` }} data-charging={charging || undefined} /></span>
              {pct === null ? t('fx.card.batteryNA') : `${pct}%${charging ? ` ${t('fx.card.charging')}` : ''}`}
            </span>
          </span>
          {firmware !== undefined && (
            <span className="fx-cell" style={{ gridColumn: '1 / -1' }}>
              <span className="fx-cell-k">{t('fx.card.firmware')}</span>
              <span className="fx-cell-v">
                {firmware ?? t('fx.card.batteryNA')}
                {firmware && connection !== 'unknown' ? ` · ${t(connection === 'wired' ? 'fx.info.wired' : 'fx.info.wireless')}` : ''}
              </span>
            </span>
          )}
        </span>
        {pct === null && probeHex && <span className="fx-probe">{t('fx.card.reply')} {probeHex}</span>}
        {xinput ? (
          <span className="fx-card-cta" style={{ display: 'block' }}>
            <span style={{ display: 'block' }}>{t('fx.card.xinputHint')}</span>
            {onDriverSwitch && (
              <button type="button" className="btn ghost sm" style={{ marginTop: 8 }} disabled={busy} onClick={onDriverSwitch} title={t('fx.card.driverTip')}>
                {busy ? t('fx.card.working') : t('fx.card.driverSwitch')}
              </button>
            )}
          </span>
        ) : (
          <span className="fx-card-cta">
            <span>{busy ? t('fx.card.working') : t('fx.card.connect')}</span>
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
        <img src={direwolf4} alt={t('fx.card.alt')} draggable={false} />
      </span>
    </Root>
  )
}
