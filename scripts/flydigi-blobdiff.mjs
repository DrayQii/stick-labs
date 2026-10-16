// Compare two Direwolf config backups (840-byte .bin files) and list every byte that changed,
// grouped into runs, with the known region each falls in. Use it to decode a Space Station setting:
// back up the slot (Backups > "Back up config N now"), change ONE setting in Space Station, let
// Stick Labs read the pad again, back up again, then run:
//   node scripts/flydigi-blobdiff.mjs before.bin after.bin
import { readFileSync } from 'node:fs'

const [a, b] = process.argv.slice(2).map((p) => (p ? readFileSync(p) : null))
if (!a || !b) {
  console.error('usage: node scripts/flydigi-blobdiff.mjs before.bin after.bin')
  process.exit(1)
}
const regions = [
  [0, 13, 'header'],
  [13, 109, 'keys'],
  [109, 123, 'sticks'],
  [123, 137, 'triggers'],
  [137, 145, 'motion'],
  [145, 154, 'vibration'],
  [154, 770, 'unknown (LED / macros / extras?)'],
  [770, 790, 'title'],
  [790, 814, 'stick curves'],
  [814, 840, 'tail']
]
const where = (o) => regions.find(([s, e]) => o >= s && o < e)?.[2] ?? '?'
const hex = (buf, s, e) => Array.from(buf.subarray(s, e), (v) => v.toString(16).padStart(2, '0')).join(' ')

if (a.length !== b.length) console.log(`length differs: ${a.length} vs ${b.length}`)
let i = 0
let runs = 0
const n = Math.min(a.length, b.length)
while (i < n) {
  if (a[i] === b[i]) {
    i++
    continue
  }
  let j = i
  while (j < n && (a[j] !== b[j] || (j + 1 < n && a[j + 1] !== b[j + 1]))) j++
  console.log(`${i}..${j - 1} [${where(i)}]\n  before: ${hex(a, i, j)}\n  after:  ${hex(b, i, j)}`)
  runs++
  i = j
}
if (runs === 0) console.log('identical')
