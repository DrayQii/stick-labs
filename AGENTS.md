# AGENTS.md — Stick Labs

Windows-first Electron app that reads/writes wired controller config over HID
(GameSir G7 family, plus a LeadJoy Saber Plus codec). `src/main` = USB/HID +
IPC, `src/renderer` = React UI, `src/shared` = pure wire codecs (no Electron,
no node-hid).

## Commands

Bare `npm`/`npx` fail on this machine (`npm.ps1` is blocked by PowerShell
execution policy) and `npx` is banned by convention — call tools with `node`:

| Task | Command |
| --- | --- |
| Typecheck main | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json` |
| Typecheck UI | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json` |
| One test file | `node scripts/test.mjs tests/leadjoy.ts` |
| Build `out/` | `node node_modules/electron-vite/bin/electron-vite.js build` |
| Portable dist | `node node_modules/electron-builder/out/cli/cli.js --win portable` |
| Dev launch | `Start-Process .\node_modules\electron\dist\electron.exe -ArgumentList "."` |

- Per-change order: typecheck (both projects) → tests → build → restart app → push.
- No linter or formatter is configured; `tsc` is the only static gate.
- PowerShell has no `&&`/`||`, no `head`/`tail` — use `;` and `Select-Object -First/-Last`.

## Tests

- `scripts/test.mjs` esbuild-bundles each *named* test into `.test-tmp/` and runs
  it with cwd = repo root, so `fixtures/` resolves.
- The no-arg default suite is **stale and fails** (it lists deleted files like
  `tests/roundtrip.ts`, `tests/commands.ts`); `npm test` is broken the same way.
  Always name test files explicitly.
- CI (`.github/workflows/release.yml`, on `v*` tags) runs typecheck, then
  `node scripts/test.mjs tests/rawbytes.ts tests/models.ts tests/t3ce.ts`, then `npm run dist`.
- `tests/` also holds hardware probe scripts (`fly*`, `live*`, `deeppoll-*`,
  `probe_*`) that are intentionally left untracked — never commit them or wire
  them into the suite.
- `tests/leadjoy.ts` proves byte-exact rebuilds against `fixtures/leadjoy/*` wire captures.

## Layout & wiring

- `src/main/index.ts` — window + every `ipcMain.handle` channel. Sessions live in
  `controller.ts` (GameSir), `leadjoy.ts` (Saber Plus), `hid.ts` (discovery),
  `deeppoll.ts`, `steam.ts`.
- `src/shared/` — `protocol.ts`, `profile.ts` (1070/1935-byte blob),
  `sticklab.ts`, `keymap.ts`, `models.ts` (model registry), `leadjoy.ts`.
- `src/renderer/App.tsx` — the entire UI in one large file; `api.ts` is the
  renderer bridge; `i18n.ts` needs **all four** languages (en/zh/ja/ru) for any new key.
- Adding an IPC channel means editing `src/main/index.ts` **and**
  `src/preload/index.ts` **and** `src/renderer/api.ts`.
- Aliases `@` → `src/renderer`, `@shared` → `src/shared` (renderer only; defined
  in `electron.vite.config.ts` + `tsconfig.json` paths).

## Protocol / hardware rules

- Match devices by **VID + usagePage + usage, never PID** (PIDs only label a pad
  after opening). GameSir: `0x3537 / 0xfff0 / 0x40`. LeadJoy: `0x4131 / 0xff80 / 0x01`.
- Writes are read-modify-write with ack + readback; a mismatch restores the old
  value. Never add a write path without a byte-exact fixture and a live readback
  proof — no guessed wire bytes.
- Live hardware writes only with explicit per-step user confirmation, and with the
  vendor app closed (GameSir Connect / LeadJoy holds the HID handle).
- Writing the running GameSir slot reboots the pad ~1–2 s — expected, not a hang.
- RE notes: `docs/leadjoy-saber.md`, `docs/tarantula-8k.md`, `docs/hyperstrike-sampling.md`.

## Editions, builds, release

- `main` = the full app. `side` = friend edition **"Stick Labs Zamilitox"**
  (trimmed tabs + preset). `rc-filter-sidebuild` = older side build. They have
  diverged — confirm which edition a task targets before branching or merging.
- Keep install IDs **frozen** on the side edition (`appId`, `productName`,
  storage keys, repo): branding is display text + artifact filenames only, so
  updates and settings survive. Only `build.*.artifactName` may differ.
- `package.json` `main` = `out/main/index.js`, so the app runs the **last built**
  `out/`. Rebuild before launching or testing UI. If the app is open while you
  edit, stop `electron`, rebuild, relaunch. After any side-branch build, rebuild
  `main`'s `out/` so the desktop shortcut isn't left on the wrong edition.
- Release = bump `version`, tag `v*`, push tags (CI publishes both exes; packaged
  apps auto-update). Don't release unless asked.
- `git remote -v` prints an origin URL containing an embedded GitHub token —
  never copy it into docs, logs, or commits.

## Local workflow file (outside the repo)

- `<workspace root>/Stick Labs.md` — the running log next to the repo. Append one
  entry per shipped commit (date, commit, what changed, how it was verified, e.g.
  "Tests + tsc green, rebuilt, restarted"). **Never commit it.**
