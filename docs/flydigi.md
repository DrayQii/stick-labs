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
