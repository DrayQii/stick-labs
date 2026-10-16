# Stick Labs — stick tuner (G7 Pro 8K · Flydigi Direwolf 4 · Tarantula detect · G7 SE locked)

Stick-only Electron companion. No remap / macros / lighting / motion code.

## What it tunes (all in the 1070-byte profile blob)

| Area | Bytes | UI |
|---|---|---|
| Bit depth 8–12 + raw unlock | `Fun_Data +16`, wire = `12 − bits` | standard buttons + raw wire 0–255 |
| Polling rate 250–8K | `Fun_Data +14`, gear 0–5 | 1K/2K/4K/8K buttons (+250/500); |
| Deadzone 0.1% steps | stick `+3..+10`, u16BE ×10 | 4 sliders + Physics / Factory presets |
| Response curve | stick `+14..+23`, 5× (x,y) | presets + plot + numeric table |
| Gate / output | stick `+1,+27,+28,+29` | square gate, axis ratio, output type, mouse DPI |
| Calibration | `0F FE <calType> <mask>` | Enter / Commit / Cancel |

Hardware truth: the ADC maxes at **12-bit (4096 levels)**. Raw wires outside
`0–4` (resolution) / `1–21` 
## Flydigi Direwolf 4

The Direwolf 4 is tuned over plain HID, with no driver and no Space Station
running. Details, byte layouts and open questions: [`docs/flydigi.md`](docs/flydigi.md).

### What you can do

| Tab | Controls |
|---|---|
| Sticks | live stick view, Center and Edge sliders (-100..100), per-stick response-curve designer (9 points) |
| Buttons | remaps, turbo (Press / Click + repeat frequency) |
| Device | triggers (start / end), gyro (mapping, activation key, dead zone, sensitivity, Racer), vibration, polling rate, pad mode |
| Profiles | the four config slots (P1..P4 in the top bar), save to pad, backups and restore |

Every edit is staged in the app and applied with **Write to controller**.

### How it works

- **Find the pad.** In DInput mode it shows as USB `04B4:2412`; its vendor
  interface (2, usage page `0xFFA0`) takes Flydigi's `05 ..` command reports.
  Close Flydigi Space Station first, because launching it flips the pad back to
  XInput (`045E:028E`).
- **Handshake.** The identify handshake (check-architecture, get-info,
  get-status) is read-only and mirrors SDL's Flydigi driver. Nothing is written
  until you press Write.
- **Config blob.** The pad stores each config slot as one 840-byte blob split
  into 10-byte packs: keys, sticks, triggers, gyro, vibration, curves. The app
  reads a slot, edits the decoded fields, and sends only the packs that changed.
- **Verified writes.** Each write is read back and compared. On a mismatch the
  previous blob is restored. Every write and restore first saves the slot to
  `flydigi-backups/` in the app data folder.
- **XInput mode.** If the pad is in XInput mode, connecting switches it to
  DInput through a small elevated helper (`scripts/flydigi-xinput-helper.py`,
  one UAC prompt, Space Station must be installed but not running). The
  **Switch to XInput** button puts it back for games. The polling rate is only
  exposed in XInput mode, so changing it runs the same helper (about 20 s).

### Connect a controller card

The Direwolf has its own card in the **Connect a controller** panel, with the
product photo, a **Mode** cell (`DInput` or `XInput`) and a **Battery** cell. In
XInput mode the card reads **Switch and connect**.

Battery comes from byte 11 of the get-info reply: the high nibble is the charge
state (0 battery, 1 charging, 2 charged) and the low nibble is the level in 20%
steps. The top of that scale is not verified on hardware yet. If the level can't
be read, the card shows `N/A` and the raw reply.

### Status

Reads, verified writes, save, make-active, deadzone, vibration, triggers and
button remaps are proven on a Direwolf 4. Turbo, gyro, the Center/Edge curve
model, backups and the integrated connect flow match Space Station's logged
bytes but are not yet tried on the pad. Calibration does not exist on this pad.

Checks that need no pad: `node scripts/test.mjs tests/flydigixinput.ts`.

## Run

```powershell
$env:PATH = 'C:\Users\Kai\AppData\Local\hermes\node;' + $env:PATH
npm.cmd install
npm.cmd run dev
```

Close **GameSir Connect** first — it holds the HID handle.
Match is `VID 0x3537 + usagePage 0xFFF0/usage 0x40`; never match PID.

Writing the **running** slot reboots the pad (~1–2 s). The write path reads
back and verifies; a failed verify restores the previous bytes.

## Checks

```powershell
$env:PATH = 'C:\Users\Kai\AppData\Local\hermes\node;' + $env:PATH
npx.cmd tsc --noEmit -p tsconfig.node.json
npx.cmd tsc --noEmit -p tsconfig.web.json
node scripts/test.mjs tests/rawbytes.ts
npx.cmd electron-vite build
```

## EXE / installer

```powershell
npm.cmd run dist   # NSIS setup + portable exe in dist/
```

Unsigned, so Windows SmartScreen will ask on first run — click through.
Re-run `dist` after any code change; the desktop shortcut runs the dev
build, the installer is the shareable artifact.

## Public release (GitHub)

1. Create the repo, push this folder as its root.
2. In `package.json` → `build.publish`, replace `YOUR_GITHUB_USER` /
   `stick-labs` with the real owner/repo.
3. (Later, optional) Code-signing: set `CSC_LINK`/`CSC_KEY_PASSWORD` in
   CI secrets and SmartScreen warnings fade as reputation builds.
4. Cut a release: bump `version`, commit, `git tag v1.0.0`, `git push --tags`.
   CI typechecks, tests, builds, and publishes both exes to the Release —
   and packaged apps auto-update from those Releases.
