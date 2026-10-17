# Flydigi (Apex / Vader) — status and capture plan

## What works now (detect-only)

| Pad family | VID:PID | Interface | Notes |
|---|---|---|---|
| Apex 5 (and Apex 3/4 on new firmware) | 37D7:2501 | usage page 0xFFA0 | report ID 0x03 commands |
| Apex 6 / 6 Pro | 37D7:2502 | usage page 0xFFA0 | unnumbered commands (report ID 0x00) |
| Vader 5 Pro (and Vader 3/4 on new firmware) | 37D7:2401 | usage page 0xFFA0 | unnumbered commands |
| Early pads (Apex 2 / Vader 2 era) | 04B4:2412 | interface 2 | name from USB string only |

On connect, Stick Labs runs the same read-only handshake SDL runs
(`src/joystick/hidapi/SDL_hidapi_flydigi.c`):

1. `5A A5 07 00 00` check-architecture → `[3]=1 [4]=0` means new architecture
2. `5A A5 01 02 00` get-info → `[5]` device id, `[6]` connection,
   `[11]` battery (hi nibble status, lo nibble level), `[15..16]` firmware BE
3. `5A A5 10` get-status → `[9]=1` when "Allow third-party apps to take over
   mappings" is on in Space Station

Device ids → names live in `src/shared/flydigi.ts` (`DEVICE_IDS`).
Close Flydigi Space Station first if the handle will not open.

## Not done: tuning

Deadzones, curves, polling rate and button remaps go through Flydigi Space
Station's config protocol, which is not public. Following the rule used for
every other pad here, nothing writes to a Flydigi pad until the framing is
captured and proven with readback.

### Capture plan (needs the pad on a Windows PC)

1. Install USBPcap + Wireshark. Plug the pad in wired.
2. Start a capture on the pad's root hub, open Space Station, open the
   stick/deadzone page. Save as `fixtures/flydigi/open-config.pcapng`.
3. Change ONE value (e.g. left stick inner deadzone 0 → 5), save in Space
   Station. Save the capture as `fixtures/flydigi/ls-deadzone-0-5.pcapng`.
4. Repeat with one other single change (outer deadzone, a curve preset,
   polling rate). One change per capture keeps the diff readable.
5. Filter `usb.bus_id == 1 && usb.device_address == <n>` (V2 pads: `5A A5 …`) and export the interrupt
   transfers. The read command for the config page and the write/ack pair
   give the record layout; a readback after the write proves it.

## Direwolf 4: how Stick Labs talks to it (current)

Plain HID only. The pad must be in **DInput mode** (USB `04B4:2412`, vendor interface 2,
usage page `0xFFA0`) and Flydigi Space Station must be **closed**: launching it switches the
pad back to XInput (`045E:028E`). No driver, no Space Station DLL and no admin rights are used.

Getting the pad into DInput mode: the pad has a hardware combo, **FN + D-pad Left for DInput and FN + D-pad
Right for XInput** (found by the maintainer, 2026-10-17). Stick Labs uses that: a pad found in XInput mode
(USB `045E:028E`, serial `FLYDIGI_DIREWOLF_4`) shows a card asking you to hold FN + D-pad Left, and connects by
itself when `04B4:2412` appears. Nothing from Flydigi is needed for this. The mode survives replugs until Space
Station runs again. "Switch to XInput" in the app (`05 ED`, plain HID) puts the pad back for games.

Nothing in the app needs Space Station any more. The polling rate (only exposed in XInput mode) goes over raw USB with
UsbDk (see "Polling rate and mode switch without Space Station" below), one UAC prompt per change; without UsbDk the app
says to install it. The earlier route through Space Station's Xbox 360 filter driver (`XboxComm64.dll`, a python
helper) and the "Or switch with Space Station's driver" button are removed: FN + D-pad Left does the switch. The sections below that mention the driver describe
how the protocol was first captured; the config traffic itself is plain HID.

Where the work stands and what is left is in **Direwolf 4: status and next steps** at the end of this file.

## Direwolf 4 (field notes from a Space Station 4.2.0.9 service log)

Space Station's internal code for it is `fp4`. It shows up under one of two USB identities:

| Mode | USB identity | How Space Station talks to it |
|---|---|---|
| DInput | `04B4:2412`, HID MI_00–MI_03 | `DInputProtocol` on **MI_02**: report `0x05`, get-info `0xEC` (`05 EC 00…`, 15 bytes), the same V1 path SDL uses. Stick Labs runs this read-only handshake. |
| XInput | `045E:028E`, serial `Flydigi_Direwolf_4` | `XInputProtocol` through Space Station's own **Xbox 360 filter driver** (`Init Xbox360 filter`). Replies come back inside Xbox 360 input reports (`00 14 … 01 A5 <cmd> <data>`). Not reachable from plain HID. |

XInput-mode command IDs seen (reads only): heartbeat `0x10`, read current
mapping config id `0x20`, extra info `0x30`, mapping config versions / hardware
function status `0x50`, read UID `0xA0`; plus `EnableRawDataTransportIn`.
Example UID reply: `… 01 A5 A0 17 21 39 38 89 2A 4B 43 30 FF FF FF FF`.
Config writes: see below.

### Direwolf 4 XInput config writes (service log + USBPcap, 2026-10-16)

Space Station's `service_log_<date>.txt` (`Logs\` next to the exe) logs each
write with its ack. The ack is an Xbox 360 input report (32 bytes here)
with `01 A5 <cmd> …` at bytes 13–15. In a pcap, filter on
`usb.capdata[14:1]==a5` (`A5` is at index 14).

| cmd | meaning | ack |
|---|---|---|
| `0x23` | start mapping-config write | `A5 23 00 …` |
| `0x24` | config pack (two per write, echoes the record) | `A5 24 <seq> <record…>` |
| `0x50` sub `03` | save current config to the pad | `A5 50 03 01` |
| `0x50` sub `05` | apply (activate) onboard config `<cfgId>`, 0-based; Space Station's 配置1 is 0 | `A5 50 05 01` |
| `0x50` sub `07` | read hardware function status | `A5 50 07 01 …` |

Observed, matched against the JSON in the log:

- Vibration `{min 60, max 255, scale 50}` → pack 2 contains `3C FF 32`;
  `scale 20` → `3C FF 14` (min `0x3C`, max `0xFF`, scale).
- Left stick `{center 13, curve [35 49 64 78 92 106 121 135 150], End 127}` →
  pack 1 contains the nine curve points (`23 31 40 4E 5C 6A 79 87 96`), pack 2
  contains center `0D` and the point1/point2 pairs (`40 40`, `7F 7F`). Remaining
  bytes not mapped yet.
- Triggers `{left end 231, right end 255}` was sent but not yet matched to bytes.

**Request framing (read from Space Station's own service code; read and
write proven on a Direwolf 4, see below).** The captures contain only interrupt IN reports from endpoint
`0x81`: no OUT or control transfers. Space Station sends commands through its
kernel minifilter (`XboxComm64.dll` `WriteData2Usb`, `\\.\XboxFilter`), which
USBPcap on the hub does not see. The service is a .NET bundle (embedded
`Flydigi.ControllerSDK` / `Flydigi.Common` assemblies), so the framing is
readable from its decompiled command classes:

- Every XInput command is a 15-byte buffer. `[0]=0xA5` (endpoint tag),
  `[1]=cmd`, rest zero unless noted. (`NewXInput` pads use a different
  `5A A5 <cmd> <len> …` frame with a sum checksum; not this pad.)
- `0x23` start: `[2]=startPack [3]=packCount [4]=0xA0 [5]=cfgId`.
- `0x24` pack: `[2..11]=10 config bytes [12]=0xA0 [13]=packNum`.
- `0x50` save, sub-command in `[2]` (`03` save current config, `05 <cfgId>` make that config active).
- Acks are 32-byte input reports with `A5` at `[14]` and the cmd at `[15]`.
- The config is one blob split into 10-byte packs. The service writes only
  packs that differ from the old config (consecutive changed packs per start).
  Blob offsets (V3.0 layout): keys 13..109 (3 bytes each), joystick 109..123
  (7 bytes per stick: type, center, p1x, p1y, p2x, p2y, end), triggers
  123..137, motion 137..145, vibration 145..154 (enable, then per motor
  enable/min/max/scale; enable bytes are `00` on, `FF` off), title 770..790.
  Unused bytes are `FF`.

Proven on a Direwolf 4 (2026-10-16, via `XboxComm64.dll` `InitXboxMonitorRes` /
`WriteData2Usb`, Space Station closed, elevated shell):

- `A5 20` returns the current config id (`ack[16]`); `A5 21 <cfgId>` returns the
  config as 84 packs of 10 bytes (`ack[15]=0x22`, `ack[16]`=pack index,
  `ack[17..26]`=data). Blob = 840 bytes, and the offsets above matched the live
  values (vibration `00 00 3c ff 14 00 3c ff 14`, left stick center `0d`).
- Write: `A5 23 0e 01 A0 01` (start pack 14, 1 pack, cfg 1), ack `A5 23`, then
  `A5 24 <blob[140..149]> A0 00`, ack `A5 24`. Changing `blob[149]` (left
  vibration scale) `0x14 → 0x32` read back as exactly that one byte; writing
  the original back restored a byte-identical blob. `0x50 03` (save) was not
  sent in this test.

Stick curves (blob 790..814, V3.1 extra; verified against a real read):
per stick 12 bytes: `type` (0 Default, 3 Custom; 1/2 presets not decoded),
nine curve points, `circularity` (1 Circular, 0 Rectangle), `edge` (raw).
Left stick at 790, right at 802. Space Station computes the points itself from its deadzone slider (plain
number, 0..100) and writes them with the main joystick record's `center` byte
(109+1 / 116+1), which equals the slider value. Fitted to its log (slider 0, 5,
10, 20, 50, 100, 13): `point[i] = clamp0(round(150 - 12.5 * (8 - i) / (1 - d/100)))`,
and 100 is flat 50. Exact for 0/10/20/50/100, within 1 on a few points at 5 and
13 (its rounding). Negative centres were also seen (-13 gave 63..150) and do not
follow this formula; not used.

Space Station's service log (`service_log_*.txt`, `FlydigiWorker Receive command from client`) records
every setting as JSON (`IpcCommandEnum_UpdateConfig`), which is how the following was decoded:

- `edge` (curve record +11, blob 801 / 813) is a signed byte, the Edge slider -100..100 (-30 = `e2`);
  the main record's centre byte (110 / 117) is the Center slider, also signed.
- The nine curve points are a straight line in output percent over input percent (raw 50 = 0%, 150 = 100%),
  extended past its ends and clamped to raw 0..150. Start: centre >= 0 crosses 0% at input c%, centre < 0
  starts at |c|%. End: edge <= 0 ends at 100% + e% at full travel, edge > 0 reaches 100% at input 100% - e%.
  `fxDeadzonePoints(c, e)` reproduces every logged combination within 1 (tests/flydigixinput.ts).
- Turbo is a key entry `[key, enableType, frequency]`: A on Press at 8 wrote `04 01 08`, R3 on Click at 15
  wrote `0f 02 0f` (Press = 1, Click = 2; frequencies seen: 8, 15, the allowed range is not confirmed).
  Turning turbo off writes the plain default entry `ff 00 00`. The Buttons tab edits it.
- Motion (gyro) block, blob 137..144, matched byte by byte to the log's `motionConfig` writes:
  `[mapping, enableKey, enableType, deadZone, sensitivity, sensitivityY, racer, enableKey2]`. Mapping 1 =
  Left stick, 2 = Right stick, 3 = Mouse, 0 = Off (`MotionMapType`; mouse bytes not yet checked on the pad). enableKey is a key id (13 RT,
  12 LT), enableType 1 = Press, 0 = Click (Space Station's `MotionEnableType`), enableKey2 255 = none. Joystick modes write the same value to
  both sensitivity bytes (25/46/30 seen); the racer byte is 1 for Racer mode and Space Station clears it when
  the mapping moves to the right stick. The mouse sensitivities, the smoothing curve and the other
  enable-type values are not decoded. Example: left, RT, Press, dead zone 8, sensitivity 46, Racer ->
  `01 0d 01 08 2e 2e 01 ff`; the Device tab's Gyro card edits it and writes only the fields you change.
- `CallGripVibration {leftValue, rightValue}` is a live motor test, not a config field.

Backups: every write and restore first saves the slot's 840-byte blob to
`userData/flydigi-backups/fp4-cfg<N>-<ISO time>.bin` (N is 0-based); the panel lists them and can
back up on demand. Restore writes a file back to its own slot through the normal verified path
(rolled back on a mismatch), refuses a file whose data version differs from the pad's, and backs up
the slot's current contents first.

Decompiled sources stay out of the repo.

Capture notes: USBPcap's `usb.idVendor` field only exists in the descriptor
response, so filter on `usb.bus_id == 1 && usb.device_address == <n>` instead.
Start the capture before making the change; the log timestamps show whether
the write landed inside the capture window.

### Direwolf 4 in DInput mode (04B4:2412) — plain HID, proven for reads

The pad can be switched in software: `A5 17` through the XInput filter path
(Space Station's legacy SwitchToDInput) re-enumerated it as `04B4:2412`
(four interfaces, vendor usage page 0xFFA0 on interface 2). The mode survives a
replug. Back to XInput: `05 ED` over plain HID (Space Station's SwitchToXInput; the panel's "Switch to XInput" button sends it and checks the pad leaves 04B4:2412) or just launching Space Station.

Same protocol, different bytes (report id 0x05 out, `04 FF F0 …` replies in;
indexes include the report id):

| action | out | reply |
|---|---|---|
| active config + count | `05 EB A0` | `[3..4]=AA AC [5]=active [7]=count` |
| read config | `05 EB <cfgId>` | `[15]=EB [3]=pack idx [5..14]=10 bytes` |
| write start | `05 EF <start> <count> A0 <cfgId>` | `[15]=EA` |
| write pack | `05 22 <10 bytes> A0 <packNum>` | `[15]=EA` |
| save / activate | `05 50 03 <ver lo/hi>` / `05 50 05 <cfgId>` | `[3]=50 [4]=sub` (shape not yet captured) |

Verified on a Direwolf 4 over this path: config reads (byte-for-byte in the layout above),
writes with readback (deadzone, vibration, triggers, button remaps), the save (`05 50 03`,
survives a replug) and make-active (`05 50 05`). This is the only transport Stick Labs uses.

Trigger records (blob 123..136, 7 bytes per trigger: `type, zero, p1x, p1y, p2x, p2y, end`).
Verified from Space Station's log acks after sliders Start 20/50/100 and End 200/110:
the slider values are the bytes (plain 0..255), `zero` = Start, `end` = End, and it
writes point 1 = (Start, Start), point 2 = (End, End); `type` stays 0. E.g. start 20 / end
255 gives `00 14 14 14 ff ff ff`, start 0 / end 110 gives `00 00 00 00 6e 6e 6e`.

Button remaps (key table at blob 13, 32 entries x 3 bytes, indexed by Space Station's
ControllerKey id: Up 0, Right 1, Down 2, Left 3, A 4, B 5, Select 6, X 7, Y 8, Start 9,
LB 10, RB 11, LT 12, RT 13, L3 14, R3 15, M1 18, M2 19, Menu 24, Home 27). Entry =
`target, enableType, frequency`: target 0xFF = default, 32 = macro, frequency > 0 = turbo.
Verified from a Space Station swap on config id 0 (A->B then B->A): the packs it wrote
were `00 00 ff 00 00 05 00 00 ff 00` and `... 05 00 00 04 00` (pack 2), i.e. entry
`05 00 00` for A and `04 00 00` for B. Stick Labs writes plain remaps as `[target, 0, 0]`.

Mode note: launching Space Station flips a DInput-mode pad (04B4:2412) back to XInput
(045E:028E), so the plain-HID transport only lasts while Space Station is not running.

Polling rate. Over plain HID (DInput) the Direwolf 4 does not expose it: `05 F2 03` returns a
short settings block with no rate byte (`0f 01 00 …`), `05 50 07` gets no reply, and `05 50 0A <code>`
is never acked and changes nothing observable. Space Station's own DInput parser agrees
(`ReportRate = (Serial != 3) ? data[9] : 0`, and the Direwolf is serial 3). In XInput mode, through the
filter driver, it works: `A5 50 07` returns a settings block with the report-rate code at ack[22]
(1 = 1000 Hz, 2 = 500, 4 = 250, 8 = 125) and `A5 50 0A <code>` sets it, with no ack, so the helper
reads it back. Verified on hardware (2026-10-16): 500 Hz set and read back as code 2, the value
survived a DInput/XInput round trip, and 1000 Hz was restored. Stick Labs therefore does this in one
elevated helper run (`--set-rate CODE` / `--read-rate`, optionally `--to-dinput`): from DInput it
sends `05 ED`, runs the helper, and waits for `04B4:2412` to return (about 20 seconds).

Measured on the pad (2026-10-17, `scripts/flydigi-rate-probe.mjs`): in DInput mode the Direwolf 4 sends about 500
input reports per second whatever the stored rate is, and sending `05 50 0A <code>` over plain HID changes neither the
live rate (500/s after 125, 250, 500 and 1000 Hz codes alike) nor the stored one (the stored rate, read back through
the XInput route, stayed at 500 Hz after a "125 Hz" command). So the rate cannot be set over plain HID. In XInput mode
the filter driver route works; the helper waits up to 12 s for the driver to see the pad after the switch (it failed
with "the filter driver cannot write to the pad" when started right after the DInput -> XInput switch), and the app
waits 2.5 s after the pad appears as an Xbox controller.

Raw USB (2026-10-17). UsbDk (PR #9, closed) did not work: its own tool lists the pad (a 49-byte configuration
descriptor), but libusb 1.0.30 (the pip build and the official one) always answered "UsbDk backend not available", with
the helper DLL on PATH, next to libusb and python.exe, preloaded, in the Windows system folder, and from an
administrator shell. **Cause found (libusb source, v1.0.30):** `libusb_init` applies options set before it (`libusb_set_option(NULL, LIBUSB_OPTION_USE_USBDK)`) *before* it starts the backend, and UsbDk's availability is only determined inside that backend start, so the option can never succeed that way; with 1.0.30 it must be set after init, on the context (`libusb_init` then `libusb_set_option(ctx, LIBUSB_OPTION_USE_USBDK)`). The probe script's `--usbdk` flag does that (untested on the pad until you run it). **WinUSB works.** With Zadig's WinUSB driver bound to the pad (XInput mode,
045E:028E), `scripts/flydigi-winusb-probe.py` talks to it through libusb: one interface (class FF/5D/01), interrupt IN
`0x81` and interrupt OUT `0x05` (max packet 64; bInterval 1 for 1000 Hz, 2 for 500 Hz). The same frames as the
filter-driver route are plain 15-byte interrupt writes to `0x05` (`A5 50 07` read, `A5 50 0A <code>` set), and the
read reply arrives on `0x81` as the 32-byte report with `A5 50 07` at [14..16] and the rate code at [22]. Verified:
set 500 Hz -> read back code 2, set 1000 Hz -> read back code 1. The pad applies a new rate by changing its USB
descriptor (the IN endpoint's bInterval) and reconnecting, so the handle used for the set dies and the read-back needs a
fresh open (which is why the rate is an XInput-mode feature). The catch is delivery: WinUSB has to replace the Xbox
driver for the pad, so while it is bound the pad is not an Xbox controller (games, Steam Input) until the driver is rolled
back in Device Manager (uninstall the device with "Delete the driver software", replug). The rate is stored in the pad, so
the one-off recipe is: Zadig -> WinUSB, run the script's `--set`, roll back. Other things that could still hold the pad
open and give `ACCESS` on the claim: the Xbox app (`XboxPcAppFT`), Steam, Space Station's service.

Curve designer. The nine curve bytes are output heights at evenly spaced input steps (0, 12.5 … 100%):
`raw = 50 + percent`, so 50 is 0% and 150 is 100%, and a deadzone writes the low points below 50, which the
pad clamps to 0% (Space Station's deadzone writes are exactly linear in the point index, which is what pins the
even spacing). Stick Labs' designer plots them as percent, lets you drag or type each point, and samples the
shared aim presets (`src/shared/aimcurves.ts`) onto the nine steps. Space Station writes the sensitivity type to
both the curve record (790) and the main stick record (109 / 116), so `fxSetCurve` sets both. Not yet checked on
hardware: how the pad responds to a non-linear custom curve (the points are assumed to be interpolated linearly).

## Direwolf 4: status and next steps

### How it is wired into the app
- Firmware: the connect card (DInput) and the Device tab's Pad mode card show the raw 16-bit firmware value from the V1
  get-info reply (`05 EC`, bytes 9..10 little-endian, e.g. `0x7141`) and, for firmware >= 0x6400, wired or wireless
  (byte 13). It is read once when the pad is found (a second HID handle can't be opened while the config session
  runs). The value is not mapped to Space Station's own version text, which the logs do not show.
- Steam export (Profiles tab, `FlydigiSteam.tsx`): writes the stick window into Steam Input's per-game controller configs
  through the existing backend (`src/main/steam.ts`, IPC `steam:exportSelected`, the games you tick, Steam closed, old
  files kept as `.sticklabs.bak`). Mapping (`fxSteamWindow`): Center > 0 -> Steam inner deadzone, Edge > 0 -> outer
  deadzone (100 - Edge), Center < 0 -> anti-deadzone on. A negative Edge and the size of a negative Center have no
  Steam equivalent, and the curve is only sent as Steam's exponent (a rough fit, experimental) when ticked. Steam
  applies this on top of what the pad already does. Not yet tried on hardware or in a game.
- Texts: the Direwolf screens are translated (English, Chinese, Japanese, Russian). The strings live in
  `src/renderer/i18n-fx.ts` (keys `fx.*`, merged into the app dictionary); key and button names, units and tool
  names stay English. Add new text there, not inline.
- Connect from the Direwolf card in the "Connect a controller" panel (`FlydigiCard.tsx`, DInput or XInput mode; the
  sidebar no longer lists it). `src/renderer/useFlydigi.ts` holds the session state; `FlydigiSections.tsx` renders
  the tabs: Sticks (live view, Center/Edge sliders, curve designers), Buttons (remaps and turbo), Device (triggers,
  gyro, vibration, polling rate, pad mode) and Profiles (config slots, save-to-pad, backups). P1..P4 in the top bar
  switch config slots and Write to controller applies every edit. Calibrate and Lab are hidden while it is connected.
- Main process: `src/main/flydigi-hid.ts` (read, verified write with rollback, save, backups and restore, mode
  switch; polling rate over UsbDk in `src/main/flydigi-usb.ts`). IPC is `flydigix:*` in `src/main/index.ts` and
  `window.sticklab.flydigiX*` in the preload. Frames, blob codec and every decoded field live in
  `src/shared/flydigi-xinput.ts` with tests in `tests/flydigixinput.ts`
  (`node scripts/test.mjs tests/flydigixinput.ts`) and the real read `fixtures/flydigi/fp4-cfg1.bin`.
- Checks that run without a pad: `npm run typecheck`, the test above, `npx electron-vite build`
  (`npm ci --ignore-scripts` is enough to install for them). Everything touching the pad needs a Windows machine
  with the Direwolf, so hardware testing stays local. Keep `package-lock.json` as it is.
- The decode method that worked best: Space Station's service log (`service_log_*.txt`, the
  `Receive command from client` JSON plus the `WriteMappingConfigPackCommandXInput` ack lines) names every setting and
  shows the bytes written, so it pins a field down faster than blob diffs. `scripts/flydigi-blobdiff.mjs` compares two
  backups when the log is not enough.

### Verified on the pad (2026-10-16)
Everything below was decoded from Space Station's logged bytes, matched in the tests, and then tried on a Direwolf 4
by the maintainer, with no problems reported. The details of what was checked (for example the exact turbo
frequency range, the gyro slider ranges and which of Press/Click holds or toggles) were not written down, so the
values still used are the ones in the code: turbo frequency 1..30, gyro sensitivity and dead zone 0..100.
- Turbo editor (Press = 1, Click = 2, frequency).
- Gyro card (mapping Left/Right, activation key, Press, sensitivity, dead zone, Racer).
- Center/Edge model for the curve (-100..100 each; five logged combinations exact, two within 1).
- Axis defaults for the live view in DInput mode (LX 0, LY 1, RX 2, RY 5, LT axis 3, RT axis 4).
- Backup and restore, config-slot switching from the top bar, and the integrated connect flow.
- Linear interpolation of the nine curve points by the pad.

### Space Station's own names and numbers

Read from the enum tables in Space Station's UI bundle (`resources/app.asar`, Vite build, `index-*.js`; the app talks to
`SpaceStationService.exe`, a .NET program, with these values). Facts only, no code taken. Several match what was
decoded from blobs, so the blob bytes very likely use the same numbers.

- **Device:** `ControllerDeviceType_FP4 = 132` (Direwolf 4; FP4_SRS 146, FP4_JDB 147, FP4_MRFZ 148 are editions).
- **Key ids (`ControllerKey_*`):** Up 0, Right 1, Down 2, Left 3, A 4, B 5, Select 6, X 7, Y 8, Start 9, LB 10, RB 11,
  LT 12, RT 13, L3 (Thl) 14, R3 (Thr) 15, C 16, Z 17, M1..M6 18..23, Menu 24, Turbo 25, Home 27, Back 28, Macro 32,
  stick directions 160 (centre) .. 168 (Up, RightUp, Right, RightDown, Down, LeftDown, Left, LeftUp), JsLeft 240,
  JsRight 241, JsWheel 242, KeyboardMouse 254, None 255.
- **Button map type (`KeyMapType_*`):** Key 0, Continuous (turbo) 1, Macro 2, MultiFunction 3, Keyboard 4.
  Turbo enable: Close 0, Press 1, Click 2 (matches the decoded turbo entries).
- **Gyro (`Motion*`):** map type Off 0, LeftJoystick 1, RightJoystick 2, Mouse 3; enable type **Click 0**, Press 1
  (so 0 is Click, not "unset"); mode FPS 0, RACER 1 (the "racer" byte). Joystick mapping has sensitivity, deadZone
  and smoothness (0..255; the UI calls <= 80 convex, >= 120 concave); mouse mapping has sensitivityX / sensitivityY
  (1..100). Press mode takes a second key (`enableKey[1]`).
- **Macros:** step event Release 0, Press 1, LeftJoystick 2, RightJoystick 3, Hold 5; enable type None 0, Once 1,
  Press 2, Click 3.
- **Sticks:** map type Joystick 0, Keyboard 1, Mouse 2, DPad 3 (keyboard: 4 or 8 directions); circularity
  Rectangle 0, Circular 1 (matches the decoded byte); response preset Default 0, Quick 1, Slow 2, Custom 3.
- **Triggers (`AdapterTriggerType_*`):** Normal 0, Race 1, Sniper 2, Recoil 3, Lock 4, Vibration 5 (may be for pads
  with force-feedback triggers only).
- **Config sections (`ConfigType_*`):** All 0, Simple 1, Led 2, Button 3, Macro 4, Joystick 5, Motion 6, Trigger 7,
  Vibration 8.
- **Separate commands** (not part of the config blob in the UI): report rate, sleep time (1 / 5 / 15 / 60 min, 0 =
  never), joystick sensitivity / precision, stick debounce, joystick auto-calibration, stick rebound, gyro debounce,
  quick config switch, mapping switch, grip and trigger vibration tests, SwitchToXInputMode.

The blob layout itself is produced by the .NET service; it was read there (below).

### Full blob layout and setting commands (from Space Station's service)

`SpaceStationService.exe` is a .NET single-file bundle; `scripts/dotnet-bundle-extract.py` unpacks it and ILSpy reads
`Flydigi.ControllerSdk.dll` (`data.parser.MappingConfigParser`, `data.model.config`, `data.command.setting`). Facts
only, nothing copied. The Direwolf 4 is protocol 0x0301 (769, "V3.1", 84 packs). Offsets below are what the parser
reads and writes; the ones already decoded here (keys, sticks, triggers, gyro, vibration, curves, data version) all
agree.

| Bytes | Field | Notes |
|---|---|---|
| 0..1 | protocol version | u16 LE, 0x0301 |
| 2 | pack count | |
| 3..12 | LED (old style) | 10 bytes |
| 13..108 | key table | 32 x `[target, enableType, turboFreq]`; target 255 = default, 32 = macro, 254 = keyboard / multi-function, else a `ControllerKey`; turbo when freq > 0 |
| 109..122 | sticks | 2 x `[preset, centre, p1x, p1y, p2x, p2y, end]`; centre and end signed (>127 means 127 - b) |
| 123..136 | trigger curves | 2 x `[type, zero, p1x, p1y, p2x, p2y, end]` |
| 137..144 | gyro | `[mapType, enableKey, enableType, deadZone, sens, sens, useMode, enableKey2]`; Mouse writes keys 255 and dead zone 0. The gyro-mouse X/Y sensitivities are not in the blob |
| 145..153 | grip vibration | `[master 0=on/255=off, L on, L min, L max, L scale, R on, R min, R max, R scale]` |
| 154..182 | trigger vibration | `[enable 0=on/1=off]` + per side 14: linear `(type, minLevel, maxLevel, filter, minStart, scale, minTime)` then micro (same 7) |
| 183..184 | "lunpan" (wheel) | 2 bytes, kept as is |
| 185..224 | adaptive trigger | per side 20: `type, bind(type, filter, scale, param x5), mixedBorder, param x10` (force-feedback pads) |
| 225..226 | data version | u16 LE |
| 230..767 | macros | see below |
| 770..789 | config title | UTF-16LE, 10 chars, padded 0xFF |
| 790..813 | curves (V3.1) | 2 x `[preset, 9 points, circularity, edge]` |
| 820..824 | macro intervals | 5 x (ms / 10), protocol < 0x0302 |
| 830..835 | gyro smoothing | `[zero, p1x, p1y, p2x, p2y, end]` (the UI's smoothness slider) |

**Macros (230..767, 538 bytes):** `count`, then 5 offset bytes (macro i starts at 6 + offset[i] x 4; offset[0] = 0,
each next one adds that macro's step count + 1), then per macro a 4-byte head `[key, repeat lo, repeat hi,
MacroEnableType]` followed by 4-byte steps `[time lo, time hi, key, MacroActionEvent]`. Step time is cumulative from
the macro start, in 10 ms units on this protocol (1 ms from 0x0302). Up to 5 macros, 64 steps each on 0x0301.

**Setting commands** (XInput frame `A5 <cmd> <sub> <val>`; DInput `05 <cmd> <sub> <val>`, cmd/sub where they differ):

| Setting | XInput | DInput | Value |
|---|---|---|---|
| report rate | 50 0A | 50 0A | 1/2/4/8 (DInput measured: ignored) |
| read status | 50 07 | F2 03 | see below |
| sleep time | 30 05 | F2 02 | minutes, 0 = never (1/5/15/60 in the UI) |
| stick debounce | 50 08 | 50 08 | 0 = on, 1 = off |
| stick auto-calibration | 50 09 | 50 09 | 0 = on, 1 = off |
| stick rebound | 50 0E | 50 0E | 0 = on, 1 = off |
| stick sensitivity | 50 0D | 50 0D | 14..20 (Highest..Lowest) |
| stick precision | 50 0B | 50 0B | 1..7 (8/10/12/9/11/14/16 bit) |
| gyro debounce | 30 0D | F5 06 | 0 = on, 1 = off |
| quick config switch | A2 <v> | FA A2 | 1 = on |
| Xbox home button | 30 0A / 30 09 | - | on / off |

Status reply: XInput (`A5 50 07`) bytes 17..27 = mapping switch (0 = on), stick debounce (0 = on), auto-calibration
(0 = on), sleep minutes, quick switch (1 = on), report rate (the byte already used here), precision, sensitivity,
rebound (0 = on), circle (1 = on), dock smart stop. DInput (`05 F2 03`): Space Station also has a nine-field reader,
but the Direwolf 4 answers the short form (its ReadAutoSleepPeriod reader), verified on the pad: `04 FF F0 F2 03 0f 01
00 ...` = sleep 15 min, quick config switch on, nothing else. So the polling rate is only readable in XInput mode.

The Device tab's **Pad settings** card uses these: sleep time and quick switch are read on connect and set with the
DInput commands, then read back with `05 F2 03`. The pad **ignores** the DInput forms of stick debounce /
auto-calibration / rebound (tested: auto-calibration off over DInput, the XInput read still said on), so those and gyro
debounce are staged in the card and sent together by **Apply stick settings**: switch to XInput, one elevated UsbDk
helper (`--settings 50:09:01,...`) writes the `A5 cmd sub val` frames in one child process, reads the settings reply
back in another (bytes 17..27, `fxDecodeXStatus`) and switches back to DInput in a third. Gyro debounce is not in the
reply, so it stays marked "sent". "Check current" under Polling rate reads the same block.

What they do, from Space Station's own help texts (`locales/en/translation.json`, paraphrased in the card's
tooltips): sleep = sleep after that long unused, Home wakes (UI offers never / 1 / 5 / 15 min / 1 h / 3 h); quick
switch = FN + A/B/X/Y selects config 1..4; stick debounce = anti-jitter filter, off makes tiny movements register but
the output wobbles at rest, and auto-calibration needs it on; auto-calibration = re-learns the centre while the stick
rests; rebound = filters the overshoot past centre when a stick springs back. Gyro debounce has no text (presumably the
gyro version of debounce). Space Station also warns that turning on gyro mapping (and "special" key mapping) lowers
the pad's polling rate. Space Station marks rebound, auto-calibration, debounces, quick switch and the Xbox home button as available
on the Direwolf 4 (`fp4`).


### Live input stream in DInput mode (`04 FE …`)

The vendor interface already streams the pad's state as reports `04 FE …` (Space Station's DInputProtocol parses
`data[0] == 0xFE`; its `data[n]` is our report byte n + 1). Layout from its OperatorDataParser; verified on the pad
(every button lights the right name, sticks and triggers follow, the gyro bytes follow tilt):

| Report byte | Content |
|---|---|
| 5, 6 | gyro X / Y (8-bit, verified: they follow tilt). Space Station also reads byte 7 as gyro Z, but that is the button byte below |
| 7 | C (bit 0), Z, M1, M2, M3, M4, M5, M6 (bits 1..7) |
| 8 | Menu (bit 0), Home (bit 3), Back (bit 4) |
| 9 | Up, Right, Down, Left, A, B, Select, X (bits 0..7) |
| 10 | Y, Start, LB, RB, LT, RT, L3, R3 (bits 0..7) |
| 17, 19 | left stick X, Y (centre 128) |
| 21, 22 | right stick X, Y |
| 23, 24 | LT, RT (0..255) |

This is the only place the back buttons (M1..M6) and C / Z show up; the Gamepad API does not report them. The Live input view uses this stream (`fxParseDInputLive`, IPC `flydigix:live`, ~30 Hz with a trailing send so a release is never lost) and falls back to the Gamepad API until the first report arrives. Raw
reporting can also be toggled with `05 F5` (Space Station's EnableRawDataTransportIn, DInput form), but the stream
already runs without it. Rates: Space Station's `ReportRate` enum is None 0, 1000 = 1, 500 = 2, 250 = 4, 125 = 8,
nothing faster.

### Next steps
1. **Gyro, remaining fields.** Mouse mapping (and its X/Y sensitivities), the other enable types, the second activation
   key and the smoothing curve (`smoothness` point1/point2/end in the log). Capture with the service log while
   changing one thing at a time in Space Station, plus a backup before and after (`flydigi-blobdiff.mjs`). Whether
   mapping 0 is "off" is also unconfirmed.
2. **Macros.** Key entry target 32 marks a macro; the macro data is elsewhere in the 154..770 region. Capture one
   simple macro and the one after adding a step.
3. **Trigger vibration**, if Space Station has it for this pad, and the live `CallGripVibration {leftValue, rightValue}`
   motor test (a button that buzzes the grips).
4. **Edge cases in the key table.** What a turbo key with a remap target does, and `enableKey2` for gyro.
5. ~~**Polling rate without Space Station.**~~ Done: native over UsbDk, verified on the pad (section below).

### Not available on this pad
- LED / RGB: Space Station's app has no LED or RGB settings for the Direwolf 4 (maintainer, 2026-10-17), so there is nothing to decode.
- Calibration: Space Station has no calibration screen for the Direwolf 4, so there is nothing to copy.

## Leaving the pad in XInput

The pad remembers DInput mode across replugs, so a user who closes Stick Labs would otherwise keep a pad that games do
not see as an Xbox controller. Setting "Return the pad to XInput when I leave Stick Labs" (Device tab, Pad mode; on
by default) sends `05 ED` on every way out:

- **Quit** (tray Quit, updater): before exiting, waits up to 6 s for the pad to leave DInput.
- **Disconnect / connecting another controller** in the app: same switch from the renderer.
- **Windows logoff/shutdown** (`session-end`) and **sleep** (`powerMonitor` `suspend`): sent at once, no waiting. After
  sleep the pad is in XInput; hold FN + D-pad Left to configure it again.
- **Crash or killed process**: `out/main/flydigi-guard.js` (app executable as plain node, detached, no window, no admin)
  starts the first time the pad is seen in DInput. It checks every second that the app is alive; once it is gone it
  switches the pad and exits.
- **Pad unplugged when the app goes away**: the helper waits up to 30 min for the pad to come back and switches it;
  failing that, the next app start switches it before anything else.

State lives in `flydigi-leave-xinput.json` in the app data folder (`enabled`, `armed` = last seen in DInput, `pid` of
the owning app run; a helper from an older run stands down when the pid changes). Code: `src/main/flydigi-leave.ts`,
`flydigi-guard.ts`, `flydigi-switch.ts`. The helper is started through a launcher that exits at once, so it has no
living parent: Task Manager does not list it in the Stick Labs group and "End task" on the app does not kill it.

## Polling rate and mode switch without Space Station (UsbDk, native) — verified

Verified on the pad from the app: DInput pad, set 500 Hz, then 1000 Hz, each read back correctly, pad back in DInput.
No Python, no Space Station.

`src/main/flydigi-usb.ts` reads/sets the polling rate and does the XInput -> DInput switch (A5 17) over raw USB with
node-usb 2.17.0 (bundles libusb 1.0.29) and the signed UsbDk driver. UsbDk lends the pad to the opening process and
hands it back to the Xbox driver afterwards, so no driver is replaced. libusb is initialised when `usb` loads and
`useUsbDkBackend()` then sets the option on that context (set before init it always fails).

What the pad and UsbDk need, all found on the pad:
- **Administrator.** UsbDk's StartRedirect refuses a normal user (libusb reports `LIBUSB_ERROR_OTHER` on open). The app
  runs `out/main/flydigi-usb-run.js` with its own executable as node (`ELECTRON_RUN_AS_NODE`) through a UAC prompt.
- **One process per USB step.** UsbDk keeps the pad claimed until the process that opened it ends, and the pad
  re-enumerates to apply a rate, so a second open in the same process fails. Send, read-back and the DInput switch each
  run as their own short-lived process; the app never opens the pad itself.
- **The rate write "fails".** The pad drops off USB to apply the rate, so the write usually ends in
  `LIBUSB_TRANSFER_ERROR` although it took effect. The read-back (fresh process, 4 s later) decides.
- **node-usb must be 2.17.x.** From 2.18 its libusb is built with Windows hotplug: the device list comes from a WinUSB
  scan at start and a later switch to UsbDk never rescans, so the pad is "not visible through UsbDk".

Without UsbDk the app shows an error asking to install it (no Space Station fallback). The Python
probe (`scripts/flydigi-winusb-probe.py --usbdk`) stays as a reference for the frames. Set `FLYDIGI_USB_DEBUG=1` for
libusb's own log. Manual test (admin shell): `node out/main/flydigi-usb-run.js --set-rate 1 --out r.json`.
