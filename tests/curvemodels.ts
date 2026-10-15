/**
 * Curve wiring on every controller Stick Labs can tune.
 *
 * The 5 LUT bytes live at stick+14..23 and the firmware transform at
 * stick+11..13, on BOTH full-support geometries (G7ProCE and T3CE). A curve
 * write must land exactly there, neutralise a stale transform (otherwise the
 * pad keeps bending the new points with the old curvature) and touch nothing
 * else in the blob.
 *
 * The other pads are covered elsewhere on purpose:
 *  - Cyclone 2 (detect-only) has single-byte deadzones/curves and is never
 *    reachable by these u16BE accessors — asserted in tests/c2.ts.
 *  - LeadJoy Saber Plus has its own 8-point curve, deadzone/anti/outer zone
 *    mapping and byte-exact write — pinned in tests/leadjoy.ts.
 *
 *   node scripts/test.mjs tests/curvemodels.ts
 */
import { GEOMETRIES, parseProfile, serializeProfile, stick } from '../src/shared/profile.ts'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures++
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const IDENTITY = [0, 64, 128, 191, 255]
const identityText = IDENTITY.map((v) => `${v}/${v}`).join(' ')

/** model → [profile length, stick section offset] */
const SHAPES: Array<[string, number, number]> = [
  ['G7ProCE', 1070, 0x394],
  ['T3CE', 1935, 0x6e1]
]

for (const [model, total, offset] of SHAPES) {
  const blob = new Uint8Array(total)
  for (const s of [0, 1]) {
    const base = offset + s * 36
    blob[base] = 1 // stick enabled
    blob[base + 11] = 1 // transform enabled
    blob[base + 12] = 3 // …but a stale, non-identity type/rate
    blob[base + 13] = 74
    IDENTITY.forEach((v, i) => {
      blob[base + 14 + i * 2] = v
      blob[base + 15 + i * 2] = v
    })
  }

  const p = parseProfile(blob, model)
  const geo = GEOMETRIES[model]
  check(`${model}: 2 stick packets of 36B at 0x${offset.toString(16)}`, p.sticks.length === 2 && geo.sticks.len === 36 && geo.sticks.offset === offset)
  check(`${model}: LUT reads identity on both sticks`, p.sticks.every((s) => stick.curve(s).map((q) => `${q.x}/${q.y}`).join(' ') === identityText))

  // Write a distinctive curve on the RIGHT stick and neutralise the transform.
  const want = [
    { x: 0, y: 0 },
    { x: 40, y: 90 },
    { x: 128, y: 128 },
    { x: 200, y: 170 },
    { x: 255, y: 255 }
  ]
  stick.setCurve(p.sticks[1], want)
  stick.markCurveIdentity(p.sticks[1])
  const out = serializeProfile(p)
  const base = offset + 36

  check(
    `${model}: LUT lands at stick+14..23`,
    want.every((q, i) => out[base + 14 + i * 2] === q.x && out[base + 15 + i * 2] === q.y),
    want.map((q) => `${q.x}/${q.y}`).join(' ')
  )
  const lm = stick.linearModule(p.sticks[1])
  check(`${model}: transform reads identity (en/0/100)`, lm.en && lm.type === 0 && lm.rate === 100)
  check(`${model}: transform wrote at stick+11..13`, (out[base + 11] & 1) === 1 && out[base + 12] === 0 && out[base + 13] === 100)

  // Nothing outside this stick's transform+LUT window may move.
  const diffs: number[] = []
  for (let i = 0; i < total; i++) if (blob[i] !== out[i]) diffs.push(i)
  const outside = diffs.filter((i) => i < base + 11 || i > base + 23)
  check(`${model}: edit touched only this stick's 11..23`, outside.length === 0 && diffs.length > 0, `${diffs.length} bytes changed`)

  // Re-parse the written blob: the curve survives a round trip.
  const again = stick.curve(parseProfile(out, model).sticks[1])
  check(`${model}: written curve re-reads byte-exact`, again.every((q, i) => q.x === want[i].x && q.y === want[i].y))
}

// Detect-only geometry must NOT be treated as a G7 curve packet.
check('Cyclone 2 stick packets are 32B (own model, never these accessors)', GEOMETRIES.C2.sticks.len === 32 && GEOMETRIES.C2.sticks.offset !== 0x394)
check('unknown layout falls back to the G7ProCE geometry', parseProfile(new Uint8Array(1070)).model === 'G7ProCE')

console.log(failures === 0 ? '\nALL CURVE-MODEL TESTS PASSED' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
