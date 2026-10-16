/**
 * Flydigi Direwolf stick-curve designer.
 *
 * The pad stores nine output heights at evenly spaced input steps (0, 12.5 … 100%).
 * Here they are plotted as percent output (0% = raw 50, 100% = raw 150, see
 * shared/flydigi-xinput.ts); drag a point up or down, type exact values, or apply one
 * of the shared aim presets (sampled onto the nine steps). Heights below 0% are what a
 * deadzone writes; they are drawn on the 0% line and edited from there.
 */
import { useRef } from 'react'
import { AIM_CURVES } from '@shared/aimcurves'
import {
  FX_CURVE_CUSTOM,
  FX_CURVE_DEFAULT,
  FX_CURVE_DEFAULT_POINTS,
  fxCurveFromDesign,
  fxCurvePercentToRaw,
  fxCurveRawToPercent,
  type FxCurve
} from '@shared/flydigi-xinput'

const W = 300
const H = 190
const PAD = 14
const toX = (i: number): number => PAD + (i / 8) * (W - PAD * 2)
const toY = (pct: number): number => H - PAD - (Math.max(0, Math.min(100, pct)) / 100) * (H - PAD * 2)

export default function FlydigiCurveDesigner(props: {
  title: string
  curve: FxCurve
  onChange: (c: FxCurve) => void
  onCopyToOther?: () => void
  otherLabel?: string
}): JSX.Element {
  const { curve, onChange } = props
  const svg = useRef<SVGSVGElement | null>(null)
  const drag = useRef<number | null>(null)
  const pcts = curve.points.map(fxCurveRawToPercent)

  const setPoint = (i: number, raw: number): void =>
    onChange({ ...curve, type: FX_CURVE_CUSTOM, points: curve.points.map((p, k) => (k === i ? raw : p)) })

  const fromPointer = (e: React.PointerEvent<SVGSVGElement>): { i: number; raw: number } => {
    const r = svg.current!.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * W
    const y = ((e.clientY - r.top) / r.height) * H
    const i = Math.max(0, Math.min(8, Math.round(((x - PAD) / (W - PAD * 2)) * 8)))
    const pct = Math.max(0, Math.min(100, ((H - PAD - y) / (H - PAD * 2)) * 100))
    return { i, raw: fxCurvePercentToRaw(pct) }
  }

  const poly = pcts.map((p, i) => `${toX(i)},${toY(p)}`).join(' ')

  return (
    <div className="stack" style={{ gap: 8 }}>
      <span className="label">{props.title}</span>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <select
          className="input"
          value={curve.type === FX_CURVE_DEFAULT ? 'default' : 'custom'}
          onChange={(e) => onChange(e.target.value === 'default' ? { ...curve, type: FX_CURVE_DEFAULT, points: [...FX_CURVE_DEFAULT_POINTS] } : { ...curve, type: FX_CURVE_CUSTOM })}
        >
          <option value="default">Default ramp</option>
          <option value="custom">Custom curve</option>
        </select>
        <select className="input" value={curve.circularity} onChange={(e) => onChange({ ...curve, circularity: Number(e.target.value) })}>
          <option value={1}>Circular</option>
          <option value={0}>Rectangle</option>
        </select>
        <select
          className="input"
          value=""
          onChange={(e) => {
            const preset = AIM_CURVES[e.target.value]
            if (preset) onChange({ ...curve, type: FX_CURVE_CUSTOM, points: fxCurveFromDesign(preset.pts) })
          }}
        >
          <option value="">Presets…</option>
          {Object.entries(AIM_CURVES).map(([key, c]) => (
            <option key={key} value={key} title={c.hint}>
              {c.label}
            </option>
          ))}
        </select>
        <label className="row" style={{ gap: 4 }} title="Raw edge (outer threshold) byte, 0..255. Its scale is not confirmed yet: 0 is what the pad ships with.">
          <span className="label">Edge</span>
          <input
            type="number"
            className="input mono"
            style={{ width: 64 }}
            min={0}
            max={255}
            step={1}
            value={curve.edge}
            onChange={(e) => {
              const v = Math.round(Number(e.target.value))
              if (Number.isFinite(v)) onChange({ ...curve, edge: Math.max(0, Math.min(255, v)) })
            }}
          />
        </label>
        <button className="btn ghost sm" onClick={() => onChange({ ...curve, type: FX_CURVE_DEFAULT, points: [...FX_CURVE_DEFAULT_POINTS] })}>
          Reset
        </button>
        {props.onCopyToOther && (
          <button className="btn ghost sm" onClick={props.onCopyToOther} title="Copy this curve, type and shape to the other stick">
            Copy to {props.otherLabel ?? 'other stick'}
          </button>
        )}
      </div>

      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', maxWidth: 420, background: 'var(--bg-2, #111)', border: '1px solid var(--line-2, #333)', borderRadius: 4, touchAction: 'none', cursor: 'grab' }}
        onPointerDown={(e) => {
          const { i, raw } = fromPointer(e)
          drag.current = i
          ;(e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId)
          setPoint(i, raw)
        }}
        onPointerMove={(e) => {
          if (drag.current === null) return
          setPoint(drag.current, fromPointer(e).raw)
        }}
        onPointerUp={() => {
          drag.current = null
        }}
      >
        {[0, 25, 50, 75, 100].map((g) => (
          <g key={g}>
            <line x1={PAD} x2={W - PAD} y1={toY(g)} y2={toY(g)} stroke="var(--line-2, #333)" strokeWidth={0.6} />
            <text x={2} y={toY(g) + 3} fontSize={8} fill="var(--muted, #888)">{g}</text>
          </g>
        ))}
        {[0, 2, 4, 6, 8].map((i) => (
          <line key={i} x1={toX(i)} x2={toX(i)} y1={PAD} y2={H - PAD} stroke="var(--line-2, #333)" strokeWidth={0.6} />
        ))}
        <line x1={toX(0)} y1={toY(0)} x2={toX(8)} y2={toY(100)} stroke="var(--muted, #888)" strokeWidth={1} strokeDasharray="4 4" />
        <polyline points={poly} fill="none" stroke="var(--accent, #f43f52)" strokeWidth={2} />
        {pcts.map((p, i) => (
          <circle key={i} cx={toX(i)} cy={toY(p)} r={5} fill={p < 0 ? 'none' : 'var(--accent, #f43f52)'} stroke="var(--accent, #f43f52)" strokeWidth={2}>
            <title>{`input ${Math.round((i / 8) * 1000) / 10}% → output ${p < 0 ? `${p}% (clamped to 0)` : `${p}%`}`}</title>
          </circle>
        ))}
        <text x={W - PAD} y={H - 2} fontSize={8} textAnchor="end" fill="var(--muted, #888)">input →</text>
      </svg>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(9, minmax(0, 1fr))', gap: 4, maxWidth: 420 }}>
        {pcts.map((p, i) => (
          <input
            key={i}
            type="number"
            className="input mono"
            style={{ width: '100%', padding: '2px 4px', fontSize: 11 }}
            min={-50}
            max={100}
            step={1}
            value={p}
            title={`input ${Math.round((i / 8) * 1000) / 10}%`}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (Number.isFinite(v)) setPoint(i, fxCurvePercentToRaw(v))
            }}
          />
        ))}
      </div>
    </div>
  )
}
