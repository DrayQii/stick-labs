/**
 * Export the Direwolf's stick window to Steam Input (the Profiles tab). Center / Edge from the Sticks tab become
 * Steam's inner / outer deadzone in the per-game controller configs of the games you tick; the backend is
 * src/main/steam.ts (plain VDF files, Steam must be closed, old files are kept as .sticklabs.bak).
 */
import { useEffect, useState } from 'react'
import { fxSteamWindow } from '@shared/flydigi-xinput'
import { fitCurveExponent } from '@shared/steamcfg'
import { api } from './api'
import { useT } from './i18n'
import { fxFmt } from './i18n-fx'
import type { Flydigi } from './useFlydigi'

const APEX = 1172470

interface Info {
  steamPath: string | null
  userId: string | null
  steamRunning: boolean
}
interface Game {
  appId: number
  name: string
}
interface GameResult extends Game {
  ok: boolean
  detail: string
}

export default function FlydigiSteam({ fx }: { fx: Flydigi }): JSX.Element | null {
  const t = useT()
  const [info, setInfo] = useState<Info | null>(null)
  const [games, setGames] = useState<Game[]>([])
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [filter, setFilter] = useState('')
  const [withCurve, setWithCurve] = useState(false)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<GameResult[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const refresh = (): void => {
    api()
      .steamInfo()
      .then(setInfo)
      .catch((e: Error) => setErr(e.message))
    api()
      .steamGames()
      .then(setGames)
      .catch(() => setGames([]))
  }
  useEffect(refresh, [])

  const { curves } = fx
  if (!curves) return null
  const left = fxSteamWindow(fx.left, fx.sc(curves.left.edge))
  const right = fxSteamWindow(fx.right, fx.sc(curves.right.edge))
  const curveExp = fitCurveExponent(
    curves.right.points.map((raw, i) => ({ x: (i / 8) * 255, y: (Math.max(0, Math.min(100, raw - 50)) / 100) * 255 }))
  )
  const found = !!info?.steamPath && !!info.userId
  const shown = games.filter((g) => g.name.toLowerCase().includes(filter.trim().toLowerCase()))
  const toggle = (id: number): void =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  async function run(): Promise<void> {
    setBusy(true)
    setErr(null)
    setResults(null)
    try {
      const r = await api().steamExportSelected(
        { begin: left.begin, end: left.end, anti: left.anti },
        { begin: right.begin, end: right.end, anti: right.anti },
        [...picked],
        withCurve ? curveExp : null
      )
      setResults(r.result.games)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
      refresh()
    }
  }

  const line = (w: ReturnType<typeof fxSteamWindow>, side: string): string =>
    `${side}: ${fxFmt(t('fx.steam.window'), { i: w.begin, o: w.end })}${w.anti > 0 ? t('fx.steam.antiOn') : ''}`
  const okCount = results?.filter((r) => r.ok).length ?? 0

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>{t('fx.steam.title')}</h3>
      <div className="hint" style={{ margin: '4px 0 8px' }}>{t('fx.steam.hint')}</div>
      {info && !found && <div className="note bad">{t('fx.steam.notFound')}</div>}
      {info?.steamRunning && <div className="note warn">{t('fx.steam.running')}</div>}
      {found && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="mono" style={{ fontSize: 12 }}>
            {line(left, t('fx.leftStick'))}
            <br />
            {line(right, t('fx.rightStick'))}
          </div>
          <label className="row" style={{ gap: 8 }}>
            <input type="checkbox" checked={withCurve} onChange={(e) => setWithCurve(e.target.checked)} />
            <span>{fxFmt(t('fx.steam.curve'), { k: curveExp })}</span>
          </label>
          <div className="hint">
            {t('fx.steam.lost')}
            {left.edgeLost || right.edgeLost ? ` ${t('fx.steam.lostNow')}` : ''}
          </div>

          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="label">{fxFmt(t('fx.steam.games'), { n: games.length })}</span>
            <input className="input" style={{ width: 180 }} placeholder={t('fx.steam.search')} value={filter} onChange={(e) => setFilter(e.target.value)} />
            {games.some((g) => g.appId === APEX) && (
              <button className="btn ghost sm" onClick={() => setPicked(new Set([APEX]))}>
                Apex Legends
              </button>
            )}
            <button className="btn ghost sm" onClick={() => setPicked(new Set())}>
              {t('fx.steam.none')}
            </button>
            <button className="btn ghost sm" onClick={refresh}>
              {t('fx.steam.refresh')}
            </button>
          </div>
          {games.length === 0 ? (
            <div className="hint">{t('fx.steam.noGames')}</div>
          ) : (
            <div className="stack" style={{ gap: 2, maxHeight: 220, overflowY: 'auto' }}>
              {shown.map((g) => (
                <label key={g.appId} className="row" style={{ gap: 8 }}>
                  <input type="checkbox" checked={picked.has(g.appId)} onChange={() => toggle(g.appId)} />
                  <span>{g.name}</span>
                </label>
              ))}
            </div>
          )}

          <div className="row" style={{ gap: 12, alignItems: 'center' }}>
            <button className="btn primary" disabled={busy || picked.size === 0 || !!info?.steamRunning} onClick={() => void run()}>
              {busy ? t('fx.steam.exporting') : fxFmt(t('fx.steam.export'), { n: picked.size })}
            </button>
          </div>
        </div>
      )}
      {err && <div className="note bad" style={{ marginTop: 8 }}>{err}</div>}
      {results && (
        <div className="stack" style={{ gap: 2, marginTop: 8 }}>
          <div className="note">{fxFmt(t('fx.steam.done'), { ok: okCount, n: results.length })}</div>
          {results
            .filter((r) => !r.ok)
            .map((r) => (
              <div key={r.appId} className="mono" style={{ fontSize: 12 }}>
                {r.name}: {r.detail}
              </div>
            ))}
        </div>
      )}
    </div>
  )
}
