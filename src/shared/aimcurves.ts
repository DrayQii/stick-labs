/**
 * Aim response-curve presets (7-point 0..255 designs). Shared by the GameSir curve
 * designer (renderer/App.tsx re-exports AIM_CURVES) and the Flydigi Direwolf designer.
 */
import { LINEAR_CURVE } from './profile'

/**
 * FPS curve pack — static 5-point dual-zone approximations of a "dynamic"
 * response (fine centre for micro-aim, hot edge for flicks). The pad has no
 * speed-sensing, so true velocity-dynamic curves are impossible; these bend
 * the same LUT a dynamic curve would average out to. All verified byte-safe:
 * curve bytes only, +14..+23. The Dynamic (CoD) entry is digitized from the
 * game's own published curve chart (thumbstick movement → rotation speed):
 * above the diagonal early, crossing at mid, settled below it late.
 */
export const AIM_CURVES: Record<string, { label: string; hint: string; pts: Array<{ x: number; y: number }> }> = {
  linear: { label: 'Linear', hint: '1:1 raw', pts: [...LINEAR_CURVE] },
  zamilitox: {
    label: 'Zamilitox',
    hint: 'shared S-curve: hot start, settled edge',
    pts: [{ x: 0, y: 0 }, { x: 26, y: 48 }, { x: 71, y: 89 }, { x: 128, y: 128 }, { x: 184, y: 166 }, { x: 230, y: 204 }, { x: 255, y: 255 }]
  },
  dynamic: {
    label: 'Dynamic (CoD)',
    hint: 'digitized from CoD chart: hot start, settled mid',
    pts: [{ x: 0, y: 0 }, { x: 64, y: 89 }, { x: 128, y: 128 }, { x: 191, y: 173 }, { x: 255, y: 255 }]
  },
  fpsAim: {
    label: 'Kiyoshi Curve',
    hint: 'calm centre, hot edge',
    pts: [{ x: 0, y: 0 }, { x: 64, y: 38 }, { x: 128, y: 100 }, { x: 191, y: 185 }, { x: 255, y: 255 }]
  },
  micro: {
    label: 'Micro-aim',
    hint: 'extra-fine centre for tracking',
    pts: [{ x: 0, y: 0 }, { x: 64, y: 28 }, { x: 128, y: 80 }, { x: 191, y: 170 }, { x: 255, y: 255 }]
  },
  flick: {
    label: 'Flick/Snap',
    hint: 'fast start for 180s',
    pts: [{ x: 0, y: 0 }, { x: 64, y: 100 }, { x: 128, y: 160 }, { x: 191, y: 215 }, { x: 255, y: 255 }]
  },
  snappy: {
    label: 'Snappy mid',
    hint: 'COD-style boosted mid',
    pts: [{ x: 0, y: 0 }, { x: 64, y: 78 }, { x: 128, y: 140 }, { x: 191, y: 200 }, { x: 255, y: 255 }]
  },
  steady: {
    label: 'Steady track',
    hint: 'Apex-style even pull',
    pts: [{ x: 0, y: 0 }, { x: 64, y: 52 }, { x: 128, y: 112 }, { x: 191, y: 188 }, { x: 255, y: 255 }]
  },  expo: {
    label: 'Expo',
    hint: 'late surge',
    pts: [{ x: 0, y: 0 }, { x: 64, y: 16 }, { x: 128, y: 70 }, { x: 191, y: 158 }, { x: 255, y: 255 }]
  },
  sacreds: {    label: 'Sacreds',
    hint: 'Hyperstrike-style smooth fast start, 10 points',
    pts: [
      { x: 0, y: 0 },
      { x: 26, y: 41 },
      { x: 49, y: 72 },
      { x: 76, y: 107 },
      { x: 102, y: 140 },
      { x: 133, y: 157 },
      { x: 153, y: 177 },
      { x: 168, y: 197 },
      { x: 191, y: 223 },
      { x: 229, y: 255 }
    ]
  },
  machixo: {
    label: 'Machixo',
    hint: 'Slow-start desensitized, tops at 94%',
    pts: [
      { x: 0, y: 0 },
      { x: 20, y: 15 },
      { x: 82, y: 61 },
      { x: 133, y: 99 },
      { x: 184, y: 138 },
      { x: 235, y: 176 },
      { x: 255, y: 240 }
    ]
  },
  nekosu: {
    label: 'Nekosu',
    hint: 'Snappy fast start, even pull, 10 points',
    pts: [
      { x: 0, y: 0 },
      { x: 12, y: 39 },
      { x: 39, y: 61 },
      { x: 69, y: 82 },
      { x: 98, y: 104 },
      { x: 131, y: 125 },
      { x: 169, y: 154 },
      { x: 207, y: 182 },
      { x: 228, y: 206 },
      { x: 255, y: 255 }
    ]
  }
}
