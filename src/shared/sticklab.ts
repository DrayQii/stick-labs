/**
 * Stick Lab helpers — insane stick configuration on top of the proven codec.
 *
 * Hardware truth (see docs in g7-forge):
 * - stick resolution wire byte (Fun_Data +16) = 12 - bits, so 0..4 = 12..8 bit.
 *   12-bit = 4096 levels is the ADC max. Anything beyond is raw-byte
 *   experimentation, not a supported mode — the UI must say so.
 */

/** Standard hardware range. */
export const BITS_MIN = 8
export const BITS_MAX = 12

export function bitsToLevels(bits: number): number {
  return 2 ** Math.round(bits)
}

export function bitsToStep(bits: number): number {
  return 65536 / bitsToLevels(bits)
}

/** Wire byte for a standard bit depth. */
export function bitsToWire(bits: number): number {
  return 12 - Math.max(BITS_MIN, Math.min(BITS_MAX, Math.round(bits)))
}

/** Effective bits implied by a raw wire byte (may be outside 8-12). */
export function wireToBits(wire: number): number {
  return 12 - (wire & 0xff)
}

/** Wire byte implied by a requested bit depth, even past silicon (wraps u8). */
export function bitsToWireRaw(bits: number): number {
  return (12 - Math.round(bits)) & 0xff
}

/** Beyond-silicon quick picks — experimental, firmware will clamp/ignore. */
export const EXTENDED_BITS: ReadonlyArray<number> = [13, 14, 16, 20, 24]

export interface RawResolutionInfo {
  wire: number
  bits: number
  levels: number
  step: number
  standard: boolean
  label: string
}

export function describeRawResolution(wire: number): RawResolutionInfo {
  const w = Math.max(0, Math.min(255, Math.round(wire)))
  const bits = wireToBits(w)
  const standard = w >= 0 && w <= 4
  let levels: number
  let step: number
  let label: string
  if (bits >= 1 && bits <= 16) {
    levels = 2 ** bits
    step = 65536 / levels
    label = `${bits}-bit · ${levels.toLocaleString()} levels · step ${step}`
  } else {
    levels = NaN
    step = NaN
    label = `wire ${w} → ${bits}-bit (out of ADC range — experimental)`
  }
  return { wire: w, bits, levels, step, standard, label }
}

/** X grid of the 5 firmware curve slots (bytes +14..+23). */
export const HW_CURVE_XS: ReadonlyArray<number> = [0, 64, 128, 191, 255]

export const DESIGN_MIN_POINTS = 2
export const DESIGN_MAX_POINTS = 10

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}

function cleanDesign(design: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  return [...design]
    .map((p) => ({ x: clampByte(p.x), y: clampByte(p.y) }))
    .sort((a, b) => a.x - b.x)
    .filter((p, i, arr) => i === 0 || p.x !== arr[i - 1].x)
}

/**
 * Shared monotone-cubic core: cleaned control points plus an evaluator.
 * Returns null for degenerate designs (<2 distinct points).
 */
function buildMonoSpline(
  design: Array<{ x: number; y: number }>
): { pts: Array<{ x: number; y: number }>; at: (x: number) => number } | null {
  const pts = cleanDesign(design)
  if (pts.length < 2) return null
  const n = pts.length
  const sec: number[] = []
  for (let i = 0; i < n - 1; i++) sec.push((pts[i + 1].y - pts[i].y) / (pts[i + 1].x - pts[i].x))
  // Endpoint tangents follow the end segments; interior tangents are the
  // secant average, zeroed at direction changes and limited to 3× the
  // smaller neighbour secant — the Fritsch–Carlson monotonicity gate.
  const tan: number[] = new Array(n)
  tan[0] = sec[0]
  tan[n - 1] = sec[n - 2]
  for (let i = 1; i < n - 1; i++) {
    if (sec[i - 1] === 0 || sec[i] === 0 || Math.sign(sec[i - 1]) !== Math.sign(sec[i])) {
      tan[i] = 0
    } else {
      const lim = 3 * Math.min(Math.abs(sec[i - 1]), Math.abs(sec[i]))
      tan[i] = Math.max(-lim, Math.min(lim, (sec[i - 1] + sec[i]) / 2))
    }
  }
  const at = (x: number): number => {
    if (x <= pts[0].x) return pts[0].y
    if (x >= pts[n - 1].x) return pts[n - 1].y
    let i = 0
    while (i < n - 2 && x > pts[i + 1].x) i++
    const x0 = pts[i].x
    const h = pts[i + 1].x - x0
    const s = (x - x0) / h
    const s2 = s * s
    const s3 = s2 * s
    return (
      (2 * s3 - 3 * s2 + 1) * pts[i].y +
      (s3 - 2 * s2 + s) * h * tan[i] +
      (-2 * s3 + 3 * s2) * pts[i + 1].y +
      (s3 - s2) * h * tan[i + 1]
    )
  }
  return { pts, at }
}

/**
 * Resample a free-point design polyline down to the 5 firmware slots.
 *
 * The pad stores exactly 5 (x, y) pairs and re-draws straight lines between
 * them, so naive slot sampling plays back a *different* polyline whenever
 * the design kinks between slots (measured up to ~10 steps off — the
 * "second curve" feel). Instead this fits the 5 slot heights to minimize
 * the worst-case deviation from the drawn design (minimax via coordinate
 * descent from the naive sample, endpoints pinned). On-slot designs are
 * already optimal, so they pass through byte-exact; smooth designs barely
 * move; kinked designs split the error instead of eating it whole.
 *
 * Fewer points in → same math, no special cases. A degenerate design
 * (<2 distinct points) falls back to linear.
 */
export function resampleCurve(
  design: Array<{ x: number; y: number }>,
  xs: ReadonlyArray<number> = HW_CURVE_XS
): Array<{ x: number; y: number }> {
  const pts = [...design]
    .map((p) => ({ x: clampByte(p.x), y: clampByte(p.y) }))
    .sort((a, b) => a.x - b.x)
    .filter((p, i, arr) => i === 0 || p.x !== arr[i - 1].x)
  if (pts.length < 2) return HW_CURVE_XS.map((x) => ({ x, y: x }))
  const at = (x: number): number => {
    if (x <= pts[0].x) return pts[0].y
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i].x) {
        const a = pts[i - 1]
        const b = pts[i]
        const t = (x - a.x) / (b.x - a.x)
        return a.y + t * (b.y - a.y)
      }
    }
    return pts[pts.length - 1].y
  }
  // Naive sample first: optimal already for on-slot/smooth designs, and the
  // starting point the descent only ever improves on.
  const y = xs.map((x) => at(x))
  // Worst deviation of the current slot heights over an x-range.
  const worst = (yy: number[], xa: number, xb: number): number => {
    let m = 0
    const lo = Math.max(0, Math.ceil(Math.min(xa, xb)))
    const hi = Math.min(255, Math.floor(Math.max(xa, xb)))
    for (let x = lo; x <= hi; x++) {
      let seg = yy[yy.length - 1]
      for (let i = 1; i < xs.length; i++) {
        if (x <= xs[i]) {
          const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1])
          seg = yy[i - 1] + t * (yy[i] - yy[i - 1])
          break
        }
      }
      const d = Math.abs(at(x) - seg)
      if (d > m) m = d
    }
    return m
  };
  // Coordinate descent: each free node minimizes the worst deviation over
  // its two adjacent segments (convex in the node height: ternary search).
  for (let sweep = 0; sweep < 25; sweep++) {
    let moved = false
    for (let i = 1; i < xs.length - 1; i++) {
      const xa = xs[i - 1]
      const xb = xs[i + 1]
      let lo = 0
      let hi = 255
      for (let it = 0; it < 40; it++) {
        const m1 = lo + (hi - lo) / 3
        const m2 = hi - (hi - lo) / 3
        const save = y[i]
        y[i] = m1
        const e1 = worst(y, xa, xb)
        y[i] = m2
        const e2 = worst(y, xa, xb)
        y[i] = save
        if (e1 < e2) hi = m2
        else lo = m1
      }
      const nv = (lo + hi) / 2
      if (Math.abs(nv - y[i]) > 1e-9) {
        y[i] = nv
        moved = true
      }
    }
    if (!moved) break
  }
  return xs.map((x, i) => ({ x, y: clampByte(y[i]) }))
}

/**
 * Resample a free-point design through a smooth spline down to the firmware
 * slots — the Marius-style "curves" feel on GameSir hardware.
 *
 * Same input/output contract as resampleCurve, but segments are joined with
 * a monotone cubic (Fritsch–Carlson tangents) instead of straight lines, so
 * corners between control points round off instead of kinking. Monotone
 * designs stay monotone: the output never wiggles backwards, it just bends
 * more smoothly. A degenerate design (<2 distinct points) falls back to
 * linear, exactly like resampleCurve.
 *
 * The pad still stores 5 linear segments, so this is honest smoothing within
 * the hardware's resolution — the orange overlay in the UI is exactly what
 * gets written, spline or not.
 */
export function resampleSpline(
  design: Array<{ x: number; y: number }>,
  xs: ReadonlyArray<number> = HW_CURVE_XS
): Array<{ x: number; y: number }> {
  const s = buildMonoSpline(design)
  if (!s) return HW_CURVE_XS.map((x) => ({ x, y: x }))
  return xs.map((x) => ({ x, y: clampByte(s.at(x)) }))
}

/**
 * Dense trace of the same spline for drawing: `samples + 1` evenly spaced
 * points across 0–255. Powers the smooth red design line in the graph so
 * what you drag is what the spline sampler writes.
 */
export function traceSpline(
  design: Array<{ x: number; y: number }>,
  samples = 64
): Array<{ x: number; y: number }> {
  const s = buildMonoSpline(design)
  if (!s) return [{ x: 0, y: 0 }, { x: 255, y: 255 }]
  const out: Array<{ x: number; y: number }> = []
  for (let i = 0; i <= samples; i++) {
    const x = (i * 255) / samples
    out.push({ x, y: clampByte(s.at(x)) })
  }
  return out
}

/** Insert a point at the middle of the longest segment (up to MAX). Always returns a new array — never the input reference. */
export function addDesignPoint(design: Array<{ x: number; y: number }>): Array<{ x: number; y: number }> {
  if (design.length >= DESIGN_MAX_POINTS) return [...design]
  const pts = [...design].sort((a, b) => a.x - b.x)
  let best = 0
  let bestGap = -1
  for (let i = 1; i < pts.length; i++) {
    const gap = pts[i].x - pts[i - 1].x
    if (gap > bestGap) {
      bestGap = gap
      best = i
    }
  }
  const a = pts[best - 1] ?? { x: 0, y: 0 }
  const b = pts[best] ?? { x: 255, y: 255 }
  const mid = { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) }
  return [...pts.slice(0, best), mid, ...pts.slice(best)]
}

/**
 * Outer threshold as a signed buffer %, Steam-style:
 * "width of the outer buffer defining the boundary of max stick input".
 *
 * Positive buffer B: max output starts at (100−B)% deflection — hotter rim.
 *   → End = (100−B)%, output ceiling untouched.
 * Negative buffer −B: max output is soft-capped at (100−B)% — tames the rim,
 *   exactly the zone where extra yaw/pitch-style effects bite.
 *   → End stays 100%, output ceiling (endAnti) = (100−B)%.
 * Zero / infinite: no software boundary — the pad's full physical range.
 *   → End 100%, ceiling 100%. "Infinite" is just these neutral bytes.
 *
 * All values in percent; bytes are tenths. begin/beginAnti untouched.
 */
export const OUTER_MIN = -100
export const OUTER_MAX = 95

export function outerBufferToBytes(bufferPct: number): { end: number; endAnti: number } {
  const b = Math.max(OUTER_MIN, Math.min(OUTER_MAX, bufferPct))
  if (b >= 0) return { end: Math.round((100 - b) * 10), endAnti: 1000 }
  return { end: 1000, endAnti: Math.round((100 + b) * 10) }
}

/** Recover the buffer from pad bytes. Neutral (1000/1000) reads as 0 = unlimited. */
export function outerBufferFromBytes(end: number, endAnti: number): number {
  if (endAnti < 1000) return endAnti / 10 - 100
  return 100 - end / 10
}

export function isOuterUnlimited(end: number, endAnti: number): boolean {
  return end === 1000 && endAnti === 1000
}

export const OUTER_PRESETS: ReadonlyArray<{ name: string; buffer: number; hint: string }> = [
  { name: 'Flick +35', buffer: 35, hint: 'max at 65% deflection' },
  { name: 'Hot +20', buffer: 20, hint: 'max at 80% deflection' },
  { name: 'Mild +10', buffer: 10, hint: 'max at 90% deflection' },
  { name: 'Neutral 0', buffer: 0, hint: 'full physical range' },
  { name: 'Cap −10', buffer: -10, hint: 'output tops at 90%' },
  { name: 'Cap −25', buffer: -25, hint: 'output tops at 75%' }
]

// ---------------------------------------------------------------------------
// Linearity bench — guided center-to-edge analysis.
//
// Method adapted from the classic linearity-tester approach (Gamepadla
// Line): calibrate center at rest, record steady center-to-rim passes,
// keep the advancing frontier of each pass, and score deviation from the
// time-interpolated ideal. All functions below are original code written
// from the method description; no third-party code is used.
// ---------------------------------------------------------------------------

/** Frontier filter threshold — samples must advance the peak by this. */
export const LIN_FRONTIER_EPS = 0.0001

/** Resampling grid density for the median curve. */
export const LIN_GRID = 100

/** Minimum passes before analysis is offered. */
export const LIN_MIN_PASSES = 3

export interface LinSample {
  t: number
  r: number
}

/**
 * Keep the advancing frontier: first sample plus every sample that beats
 * the running peak by at least eps. Drops backtracks and flat repeats —
 * the dropped share is the tremor signal.
 */
export function linFrontier(values: ReadonlyArray<number>, eps = LIN_FRONTIER_EPS): { kept: number[]; dropped: number } {
  const kept: number[] = []
  let peak = -Infinity
  let dropped = 0
  for (const v of values) {
    if (kept.length === 0 || v - peak >= eps) {
      kept.push(v)
      peak = v
    } else {
      dropped++
    }
  }
  return { kept, dropped }
}

/** Tremor % = share of samples the frontier filter drops. */
export function linTremor(total: number, kept: number): number {
  if (total <= 0) return 0
  return Math.max(0, 100 - (100 * kept) / total)
}

/** Resolution = 1 / mean frontier step, floored; 0 when stepless. */
export function linResolution(frontier: ReadonlyArray<number>): number {
  if (frontier.length < 2) return 0
  let sum = 0
  for (let i = 1; i < frontier.length; i++) sum += Math.abs(frontier[i] - frontier[i - 1])
  const mean = sum / (frontier.length - 1)
  if (!(mean > 0)) return 0
  return Math.floor(1 / mean)
}

function linAt(points: ReadonlyArray<number>, times: ReadonlyArray<number>, t: number): number {
  const n = points.length
  if (n === 0) return 0
  if (t <= times[0]) return points[0]
  if (t >= times[n - 1]) return points[n - 1]
  let i = 0
  while (i < n - 2 && times[i + 1] < t) i++
  const t0 = times[i]
  const t1 = times[i + 1]
  if (!(t1 > t0)) return points[i]
  return points[i] + ((t - t0) / (t1 - t0)) * (points[i + 1] - points[i])
}

/** Resample one pass onto a uniform 0..1 time grid (linear, clamped). */
export function linResample(points: ReadonlyArray<number>, times: ReadonlyArray<number>, grid = LIN_GRID): number[] {
  const out: number[] = []
  if (points.length === 0 || times.length === 0 || grid < 2) return out
  const t0 = times[0]
  const t1 = times[times.length - 1]
  for (let i = 0; i < grid; i++) {
    const t = t1 > t0 ? t0 + ((t1 - t0) * i) / (grid - 1) : t0
    out.push(linAt(points, times, t))
  }
  return out
}

/** Per-grid-point median across passes (proper even-count averaging). */
export function linMedian(grids: ReadonlyArray<ReadonlyArray<number>>): number[] {
  if (grids.length === 0) return []
  const width = Math.min(...grids.map((g) => g.length))
  const med: number[] = []
  for (let i = 0; i < width; i++) {
    const col = grids.map((g) => g[i]).sort((a, b) => a - b)
    const n = col.length
    med.push(n % 2 === 1 ? col[(n - 1) / 2] : (col[n / 2 - 1] + col[n / 2]) / 2)
  }
  return med
}

/** Index of the pass closest (L1) to the median curve. */
export function linRepresentative(grids: ReadonlyArray<ReadonlyArray<number>>, median: ReadonlyArray<number>): number {
  let best = 0
  let bestDist = Infinity
  for (let k = 0; k < grids.length; k++) {
    const g = grids[k]
    let d = 0
    for (let i = 0; i < median.length && i < g.length; i++) d += Math.abs(g[i] - median[i])
    if (d < bestDist) {
      bestDist = d
      best = k
    }
  }
  return best
}

export interface LinNonlinearity {
  avgPct: number
  maxPct: number
  score: number
}

/**
 * Deviation from the time-interpolated ideal, as % of pass range.
 * Score = min(100, 1.5 × (0.4 × avg + 0.6 × max)) — max-heavy by design,
 * so single kinks count more than uniform wobble.
 */
export function linNonlinearity(points: ReadonlyArray<number>, times: ReadonlyArray<number>): LinNonlinearity {
  const n = points.length
  const empty = { avgPct: 0, maxPct: 0, score: 0 }
  if (n < 3 || times.length < 3) return empty
  const start = points[0]
  const end = points[n - 1]
  const t0 = times[0]
  const t1 = times[times.length - 1]
  const range = Math.abs(end - start)
  if (!(range > 0) || !(t1 > t0)) return empty
  let total = 0
  let max = 0
  let count = 0
  for (let i = 1; i < n - 1; i++) {
    const progress = (times[i] - t0) / (t1 - t0)
    const ideal = start + progress * (end - start)
    const dev = Math.abs(points[i] - ideal)
    total += dev
    if (dev > max) max = dev
    count++
  }
  if (count === 0) return empty
  const avgPct = ((total / count) / range) * 100
  const maxPct = (max / range) * 100
  return { avgPct, maxPct, score: Math.min(100, 1.5 * (0.4 * avgPct + 0.6 * maxPct)) }
}

/** Linearity % = 100 − nonlinearity score. */
export function linLinearity(points: ReadonlyArray<number>, times: ReadonlyArray<number>): number {
  return 100 - linNonlinearity(points, times).score
}
