# Stick Labs

Stick Labs is a Windows-first Electron app for tuning wired GameSir controllers
over HID. It supports full profile editing on the GameSir G7 Pro 8K and
Tarantula 8K (T3CE). The Flydigi Direwolf 4 is tuned over plain HID (see below). The LeadJoy Saber Plus has its own protocol and supports
button remaps, stick curves and zones, read-only trigger deadzones, and
controller-rate settings. Other listed models are detect-only or unsupported; profile editing
stays locked unless the model's wire format has been verified.

The app includes staged edits with verified writes, curve and deadzone tools,
button remapping, profiles, calibration, diagnostics, Steam configuration
export, and USB polling analysis. The exact available screens depend on the
edition being built.

## Requirements

- Windows
- Node.js and dependencies installed with `npm install`
- Close GameSir Connect or the LeadJoy vendor app before connecting; they can
  hold the controller's HID interface

## Development

Use `node` to run project tools in this Windows environment:

```powershell
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json
node scripts/test.mjs
node node_modules/electron-vite/bin/electron-vite.js build
Start-Process .\node_modules\electron\dist\electron.exe -ArgumentList "."
```

To run one deterministic test file, pass its path, for example:

```powershell
node scripts/test.mjs tests/leadjoy.ts
```

Live hardware probes are opt-in and are not part of the default test suite.
Do not run them as ordinary tests: hardware writes require explicit per-step
confirmation, a closed vendor app, and verified readback/restore behavior.

## Flydigi Direwolf 4

The Direwolf 4 is tuned over plain HID, with no driver and no Space Station
running. Details, byte layouts and open questions: [`docs/flydigi.md`](docs/flydigi.md).

<img width="1201" height="850" alt="image" src="https://github.com/user-attachments/assets/d70ea882-e994-4a4b-9f97-3bdeef47a30f" />

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

## Build Windows installers

```powershell
node node_modules/electron-vite/bin/electron-vite.js build
node node_modules/electron-builder/out/cli/cli.js --win
```

The app reads `out/` at launch, so rebuild before starting it after code
changes. Installer and portable artifacts are written under `dist/`.

## Device safety

- Devices are opened by vendor ID plus HID usage page and usage, never by PID.
- Profile and setting writes use read-modify-write, acknowledgement, and
  readback verification; a mismatch triggers a restore attempt.
- Writing the active GameSir profile can reboot the controller for one to two
  seconds.
- Do not release a build unless the release is explicitly requested. See
  `AGENTS.md` for project architecture, hardware rules, edition conventions,
  and release workflow.
