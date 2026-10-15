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
- Curves: wire = round(percent/100*32768), 100% clamps 32768 -> 32767.
  Left `[[0,0],[16.6,16.1],...]` <-> `[0,0,5439,5276,...]`; right deadzone
  head `[30,0]` <-> `[9830,0]`. Triggers: Linear mode = 2, dz `[5,95]`.

## Encoder proof (no hardware write)

Parsing Main buttons, clearing M1 to Origin, and re-encoding for slot 1
reproduces the captured Sub1 document byte-for-byte (`tests/leadjoy.ts`).

In-app reads ship: `src/main/leadjoy.ts` runs the vendor navigation queries
through the shared builders and returns a read-only snapshot, shown on the
Saber Plus card. Buttons are fully writable 1:1 (all 22 ids × Main/Sub1/Sub2,
verified writes through `leadjoy:writeButton`); sticks/triggers stay
read-only until their write records are captured.

## Open (needs captures)

- Live write proof DONE 2026-10-15: `ljWriteButtonVerified` rewrote the
  value the pad already held (M1->X), got the `{c:61,e:0}` ack, and read
  back a byte-identical record (`verified=true`, no restore needed).
- Keyboard/mouse target `t` values (out of 1:1 scope; A/B/Y/X are proven).
- Trigger mode enum beyond Linear=2; shape enum beyond Circle=1.
- Live input report layout (XInput interface, separate from MI_04).
