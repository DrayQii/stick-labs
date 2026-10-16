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

Getting the pad into DInput mode: from XInput mode the only known way is the legacy `A5 17`
frame sent through Space Station's Xbox 360 filter driver (`XboxComm64.dll`). Stick Labs does
this on "Read pad" when it finds the pad in XInput mode (USB `045E:028E`, serial
`FLYDIGI_DIREWOLF_4`): it launches `scripts/flydigi-switch-to-dinput.py` elevated (one UAC
prompt), which sends that single frame, then waits for `04B4:2412`. It needs python on PATH
(or `FLYDIGI_PYTHON`), Space Station installed but not running, and nothing else. The mode then
survives replugs until Space Station runs again. "Switch to XInput" (`05 ED`, plain HID) puts
the pad back for games and closes the Direwolf screen. The sections below that mention the
driver describe how the protocol was first captured; the config traffic itself is plain HID.

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

Polling rate (a device setting, not part of the config blob). Space Station sets it with
`A5 50 0A <code>` (XInput form) / `05 50 0A <code>` (DInput form); there is no ack, so Stick
Labs verifies by reading the device settings back. Codes: 1 = 1000 Hz, 2 = 500, 4 = 250,
8 = 125 (the Direwolf has no 8K gears). The settings read is `A5 50 07` / `05 F2 03`; the
XInput ack (`A5 50 07 01 00 01 0F 01 01 01 11 01 …` on this pad) holds, from ack[17]: mapping
switch, stick debounce, auto calibration (0 = on), sleep time, quick switch, **report rate
(ack[22]; code 1 here = 1000 Hz)**, precision, sensitivity, rebound. The DInput reply layout is
taken from Space Station's DInput parser and not yet seen on hardware.

