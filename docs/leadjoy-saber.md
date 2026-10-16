# LeadJoy Saber Plus (VID 0x4131 PID 0x3519) — wire record

Config lives on MI_04 (usage page 0xFF80/0001). 64B HID reports, MessagePack
payloads, additive checksum (`sum(all preceding frame bytes) & 0xFF`).

## Framing

- OUT: `[A5][LEN][CC][msgpack][CK]`, zero-padded to 64B. LEN covers the frame
  including CK. Proven byte-exact from our handle (node-hid report ID 0 + 64B).
- IN single-frame: `[A5][LEN][CC][msgpack][CK]` (+ pad). Records 12, 51, 90, 220.
- IN fragmented: first `[A4][40][CC][80|total][chunk][CK]`, middle
  `[A4][40][CC][remaining][chunk][CK]`, final `[A4][LEN<40][CC][01][chunk][CK]`
  (+ pad). Chunks concatenate to one MessagePack document. Records 60 (30
  frames), 100 (11), 70 (8), 120 (2).

## Records (c, b = board 1, slot = Main/Sub1/Sub2 0/1/2)

| c   | shape | meaning |
| --- | ----- | ------- |
| 12  | 1 frame | version string, e.g. `36.16.12` |
| 51  | 2 frames | board `{b, d2:{a, n:"DEFAULT_BOARD", cfg:[...]}}` |
| 60  | 30 frames | buttons `{b, c:slot, d1:[22x {k,a,dn,up}]}` |
| 70  | 8 frames | stick `{b, c:slot, d:side, d1:{co,ci,cv[16],cpl/cpu/cpr/cpd,...}}`, d 0 = left |
| 90  | 1 frame | triggers `{b, c:slot, d1:{mol,dzl:[in,out],vtl,mor,dzr,vtr}}` |
| 100 | 11 frames | global/motion `{b, c:slot, d1:{sj,tm,tk,kao,cv,se,hvr,...,ec,el}}` |
| 120 | 2 frames | rumble `{b, c:slot, d1:{enl,grl,trl,trml,enr,grr,trr,trmr}}` |
| 220 | 2 frames | motion-device colors `[{mkn,c:[r,g,b],s}]` |

Button query carries 22 ids in vendor order
`[26,27,24,25,1,2,4,5,14,15,17,18,19,20,7,8,9,10,11,16,12,3]`; the pad
answers sorted ascending. Id map (JSON-order aligned, anchored by hardware):
a=1 b=2 x=4 y=5 l1=7 r1=8 l2=9 r2=10 select=11 start=12 l3=14 r3=15
capture=16 up=17 down=18 left=19 right=20 m1=24 m2=25 m3=26 m4=27 c=3.
Physical layout (user-confirmed): R5/L5 are the rear paddles, R4/L4 the
extra bumpers. Wire anchor: R5 = M1 (id 24) — the R5->X flip arrives as
m1->X in JSON and `dn {t:2,v:[4,0,0,0]}` on the wire. M2/M3/M4 <-> L5/R4/L4
order still open (one distinct flip each will settle it).

## Proven flips (pad-confirmed)

- R5 (M1, id 24) -> X: `dn {t:2, v:[4,0,0,0]}`, Origin is `t:0 v:[0,0,0,0]`.
  Targets reuse the source-id space.
- Save-flush capture (`binds`): four single-record writes, two A4 fragments
  each, 96B documents:
  - k=26 -> v=[1] (JSON m3->A), k=25 -> v=[2] (m2->B),
    k=27 -> v=[5] (m4->Y), k=24 -> v=[4] (m1->X).
  - So A=1, B=2, X=4, Y=5. Physical order confirmed by the user
    (R4->A, L5->B, L4->Y): R5=M1(24), L5=M2(25), R4=M3(26), L4=M4(27).
- Write envelope: `{"c":61, "w":{"b":1,"c":slot,"d1":[{k,a,dn,up}]}}` —
  record 61 under key `w` (reads: 60 under `g`). Write action maps use
  t,v,n,r,sp,mr,ms,ri order (reads return t,n,mr,ms,r,sp,ri,v); the builder
  reproduces the capture byte-exact, fragments included.
- Each write is acked with single-frame `{"c":61,"e":0}` (checksum-verified).
  No separate save/commit command exists in the capture — flips write
  through live; Save persists locally (pad re-enumerates after, fresh
  session ritual at +21s).
- Stick writes (`sticks` capture): full-side `{"c":71,
  "w":{"b":1,"c":slot,"d":side,"d1":{...}}}` (read 70 + 1, same rule),
  8 fragments each, acked with single-frame `{"c":71,"e":0}` (28 acks for
  28 writes). d1 layout and key order match reads; action maps use the
  write order t,v,n,r,sp,mr,ms,ri. Rebuilding the final left/right
  documents from parsed d1 reproduces the capture byte-exact, fragments
  included. Session content: right deadzone dragged 30→25% live (head
  9830→8192), left curve redrawn to a 10% head (3277). Triggers were NOT
  flipped in this capture — record 90/91 writes are still open.
- Curves: wire = round(percent/100*32768), 100% clamps 32768 -> 32767.
  Left `[[0,0],[16.6,16.1],...]` <-> `[0,0,5439,5276,...]`; right deadzone
  head `[30,0]` <-> `[9830,0]`. Triggers: Linear mode = 2, dz `[5,95]`.

## Encoder proof (no hardware write)

Parsing Main buttons, clearing M1 to Origin, and re-encoding for slot 1
reproduces the captured Sub1 document byte-for-byte (`tests/leadjoy.ts`).

In-app control ships through the **same UI as the GameSir pads**: connecting
the Saber Plus marks it connected and reads Main immediately, slots live in
the topbar (Main/Sub1/Sub2, same spot as P1–P4), and edits stage until the
topbar Write commits them. The Sticks tab mirrors the GameSir Sticks tab card
for card — live cross, dead zone + anti-deadzone, outer threshold, custom
curve designer, shape (gates: Circle / Rounded rectangle). Buttons (all 22
ids, 1:1 remaps) and stick curves / deadzones / gate are writable, each record
written live, acked and read back (`leadjoy:writeButton` / `writeStick`); a
mismatch restores the old value. Trigger deadzones are displayed read-only:
record 90/91 has a fixture-tested codec, but runtime writes stay disabled until
a no-op rewrite is proven with live hardware readback. Records that are not decoded for this pad (report-rate,
resolution) stay untouched and say so in the Device tab.

This pad has no separate deadzone/anti bytes, so the GameSir card's four
numbers land on the curve endpoints: START/ANTI-START are point 1 (in/out),
END/ANTI-END are point 8 (in/out) — `ljCurveZones` / `ljFitZones` /
`ljLinearCurve` / `ljSampleDesign` in `src/shared/leadjoy.ts`, pinned in
`tests/leadjoy.ts`.

## Vendor field names ↔ wire fields (record 70 / joystick)

Proven by reading the pad and cross-checking the vendor app's own
`DEFAULT_BOARD.json` (which mirrors the pad with names):

| Vendor JSON | Wire | Meaning |
| ----------- | ---- | ------- |
| `center_offset` | `co` | centre offset (pair) |
| `shape` | `ci` | gate (Circle = 1, RoundedRectangle = 0) |
| `release_joystick_cut` | `rjc` | 0/1 |
| `mouse_mapping.enabled` | `mm` | 0/1 — mouse output |
| `mouse_mapping.sensitivity` | `mse` | controller rate (50 = stock neutral) |
| `mouse_mapping.operation_mode` | `mom` | 0 = Vector (`Fixed` code not yet read) |
| `x_axis_reversed` / `y_axis_reversed` | `xr` / `yr` | 0/1 |
| `anti_shake_factor` | `asf` | 0..100 assumed, range unconfirmed |
| `curve.points` | `cv` | 8 × (in,out) wire ints |
| `triggers.*.trigger_radius` | `cpl`/`cpu`/`cpr`/`cpd` | per direction |
| `triggers.*.action` | `tkl`/`tku`/`tkr`/`tkd` | per-direction stick-trigger bind |

Record 100 (`global`) is the **motion/gyro** config, not device-level: its
fields line up with `main.motion.stick_like` (`sj` = simulate type, `tm` =
trigger mode, `tk` = trigger keys, `cv` = response-curve points,
`se` = sensitivity, `hvr` = horizontal/vertical ratio, `had` = horizontal axis
direction, `hsr`/`hrr`/`vr` = reversals, `st` = sensor type, `ec`/`el` =
button-like axis triggers/actions).

`ljApplyStickPatch` writes these as a validated read-modify-write patch
(unlisted fields pass through untouched), so a `cv`-only or `mse`-only change
never disturbs the rest of the image.

## Sub1/Sub2 are shift layers, not switchable profiles (2026-10-15)

The pad stores three full config sets (`main`/`sub1`/`sub2`, vendor JSON naming)
in records 60/70/90/100/120 through the `c` slot field. The slot is honoured:
a record-60 read for slot 0/1/2 comes back as `{"c":60,"e":0,"r":{"b":1,"c":<slot>,
…}}`, byte-different per slot (verified live: slot 0 held the four keyboard/mouse
binds, slots 1 and 2 were all-Origin).

Record 51 is the board header and carries the sub-layer gate:

```
{"c":51,"e":0,"r":{"b":1,"d2":{"a":1,"n":"DEFAULT_BOARD",
  "cfg":[{"c":1,"ko":1,"at":0,"k":[]},{"c":2,"ko":1,"at":0,"k":[]}]}}}
```

Vendor names (its own `DEFAULT_BOARD.json`): `a` = `activated`, `n` = `name`,
`cfg[].c` = sub index (1/2), `ko` = `subN_keep_original`, `at` =
`subN_action_type` (0 = `Responsive`; `Toggle` is the other vendor value),
`k` = `subN_trigger_keys` (`subN_trigger_key_logic` = `And`/`Or` rides the same
family).

**An empty `k` means the sub layer is unreachable** — the pad applies sub1/sub2
only while their trigger keys are held. So binds written into Sub1/Sub2 look
dead while main's keep working: that is the configured state, not a failed
write. Making them usable needs a write for the sub config (record 51 family)
whose shape is not captured yet.

Read-only id probes (no writes sent): 50 answers `r:1` (vendor
`GetProfileCount`); 51 answers the board map; **52 answers nothing and the pad
re-enumerates right after** a `{c:52,b:1}` frame — the same flush the vendor
app's Save causes. The vendor DLL's id table (`device_manager_lib.dll`, file
offset `0x2045f8`) lists the neighbours: 17/18, 30/31, 40–49, 50–56, 60/61,
70/71, 90/91, 132–135, 170–175, 190–192, 220–222/224.

Live no-op board write (2026-10-15, user-confirmed, nothing meant to change):
the derived frame `{"c":52,"w":{"b":1,"d2":{a,n,cfg}}}` (read 51 + 1, the same
R→R+1 rule proven for 60→61 / 70→71 / 90→91, payload = the board's own current
values, 2 fragments) got **no ack at all**, and the board re-read byte-identical
(`identical=true`, no re-enumeration). So record 52 does not accept that shape
and the sub-config write stays uncaptured — nothing further was probed, per the
no-guessed-wire-bytes rule.

Why there is no vendor-side writer to capture: the DLL's `ButtonAction` enum is
exactly `Origin` / `GamepadButton` / `KeyboardKey` / `MouseButton` / `Macro`
(`struct variant ButtonAction::*`), so the app has **no layer/switch target**,
and the sub tabs (`ConfigTabs`: Main/Sub1/Sub2) are only the keymap editor. The
vendor app therefore ships editable-but-inert sub keymaps: nothing in it emits a
board/sub-config write, so a capture has nothing to record until a setter action
exists somewhere.

The vendor UI's own strings (`ConfigTabs`: `Main`/`Sub1`/`Sub2`, analytics
`page_view_sub_keymaps` with `config_slot`) show the sub tabs are the same
keymap editor; the activation fields are named only in the DLL/JSON.

## No-admin RE sources (use these first)

- `%LOCALAPPDATA%\Packages\ShenzhenDynamicFingertipN.leadjoy-pc-app_bx86y63yhsmre\LocalCache\Local\Leadjoy\logs\debug.log`
  — the vendor app logs **every** `execute_json {"command":…}` it sends, with
  wire-unit payloads. Changing a setting in the app and reading this is a
  command-level capture that needs no admin.
- `…\LocalCache\Local\Leadjoy\configs\Saber\DEFAULT_BOARD.json` — the pad's
  current state with vendor **names** (shape, modes, mouse mapping…). Toggle a
  setting in the app, then read the pad and the JSON: that is how the shape
  codes and every field above were named.
- `C:\Program Files\WindowsApps\ShenzhenDynamicFingertipN.leadjoy-pc-app_*_x64__bx86y63yhsmre\VFS\ProgramFilesX64\Leadjoy\device_manager_lib.dll`
  — Rust library; its serde string table names every command and struct field.

Device-level commands the library exposes: `Get/SetPollingRate` (`rate`),
`Get/SetControllerMode` (`xinput`/`switch`/`ps4`/`ps5`/`mt`), `Get/SetDualOutput`,
`Get/SetJoystickDpadSettings` (swap / output direction / diagonal lock),
`SetStepSize` (`default`/`four_way`/`eight_way` — **D-pad**, not sticks),
`ToggleButtonReporting`, `Start/EndCalibration` (joystick + trigger), motion
control devices, FPS profiles and macros. There is **no** stick-resolution /
bit-depth command or field anywhere — 8–12 bit is GameSir-only, so the Device
tab says so rather than faking a control.

## Open (needs captures)

- Sub-layer gate write (record 51/52 family): `cfg[].k` (trigger keys), `ko`,
  `at` for sub1/sub2 — needs either a capture of the vendor app setting a sub
  trigger key, or an admin USBPcap/ETW session. Until then Sub1/Sub2 stay
  editable-but-inert on the pad.

- Live write proof DONE 2026-10-15: `ljWriteButtonVerified` rewrote the
  value the pad already held (M1->X), got the `{c:61,e:0}` ack, and read
  back a byte-identical record (`verified=true`, no restore needed).
- Live stick write proof DONE 2026-10-15: `ljWriteStickVerified` rewrote
  the right side the pad already held (25% head, full image), got the
  `{c:71,e:0}` ack, and read back a byte-identical image (`verified=true`,
  independent re-read matches).
- Trigger writes (record 90/91): codec + builder shipped (byte-exact vs the
  LT-deadzone capture, `tests/leadjoy.ts`); field proof = a no-op deadzone
  rewrite the next time the pad is on the bench (user-confirmed step).
- Trigger mode enum beyond Linear=2. Stick gates are settled: **Circle = 1,
  RoundedRectangle = 0** — proven 2026-10-15 by switching each in the vendor
  app and reading `ci` off the pad, correlated with the vendor's own
  `DEFAULT_BOARD.json` labels. The library also carries a `LeftRight` variant,
  but the app offers no such option, so `ljValidateShape` refuses anything
  other than 0/1.
- Keyboard/mouse target `t` values (out of 1:1 scope; A/B/Y/X are proven).
- Live input: the pad's vendor interface 0 (class 0xFF/0x5D/0x01, EP 0x81 IN,
  32-byte reports per its config descriptor) is exposed by Windows as HID node
  `IG_01` (usage 0x0001/0x0005), but hidapi reads NOTHING from it — event API,
  async `read()`, and blocking `readSync()`, both hidraw and libusb backends,
  exclusive and shared, all silent for 40 s with both sticks moved (live
  hardware, 2026-10-15); the 0xFF80 config interface pushes no unsolicited
  frames either. USBPcapCMD cannot settle it here either: it needs admin
  (writes a 24-byte header and exits as a normal user) and elevation shows no
  prompt in this environment. The Sticks tab's live cross is therefore driven
  by the **system Gamepad API** (`navigator.getGamepads()` in the renderer) —
  Windows exposes the pad as a standard Xbox-compatible gamepad, so it needs no
  capture, driver or admin. Raw endpoint-level decoding of the 32-byte stream
  stays open for a future unfiltered `USBPcapCMD -A` capture, but nothing in
  the app depends on it.
