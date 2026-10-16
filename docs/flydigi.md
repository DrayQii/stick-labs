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
5. Filter `usb.idVendor == 0x37d7` and export the `5A A5 …` interrupt
   transfers. The read command for the config page and the write/ack pair
   give the record layout; a readback after the write proves it.
