"""One-shot helper: switch a Flydigi Direwolf 4 from XInput to DInput mode.

Sends Space Station's legacy "SwitchToDInput" frame (A5 17) through the Xbox 360
filter driver that Flydigi Space Station installed (XboxComm64.dll). This is the
only part of Stick Labs that touches that driver, and only for this one frame;
everything else talks plain HID. Stick Labs launches this elevated (UAC prompt)
when "Read pad" finds the pad in XInput mode.

Needs: administrator rights, Flydigi Space Station installed (for its DLL and
driver) but NOT running, the pad wired and in USB mode.

Usage: python flydigi-switch-to-dinput.py --out result.json
Writes {"ok": true} or {"ok": false, "error": "..."} to --out (an elevated
process cannot share stdout with its launcher). Exit code 0 on success.
"""
import ctypes
import json
import os
import sys
import time

OUT = None
if "--out" in sys.argv:
    OUT = sys.argv[sys.argv.index("--out") + 1]


def finish(ok, error=None):
    if OUT:
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump({"ok": ok, "error": error}, f)
    if not ok:
        print(error, file=sys.stderr)
    sys.exit(0 if ok else 2)


def find_space_station():
    candidates = []
    if os.environ.get("FLYDIGI_SS_DIR"):
        candidates.append(os.environ["FLYDIGI_SS_DIR"])
    for drive in ("C", "D", "E", "F"):
        candidates.append(drive + r":\Program Files\Flydigi Space Station")
        candidates.append(drive + r":\Program Files (x86)\Flydigi Space Station")
    for c in candidates:
        if os.path.exists(os.path.join(c, "driver", "XboxComm64.dll")):
            return c
    return None


ss = find_space_station()
if not ss:
    finish(False, "Flydigi Space Station's driver folder was not found (install it, or set FLYDIGI_SS_DIR).")

drv = os.path.join(ss, "driver")
sys_path = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "drivers", "Xbox360Filter64.sys")
if not os.path.exists(sys_path):
    sys_path = os.path.join(drv, "Xbox360Filter64.sys")

try:
    os.chdir(drv)
    dll = ctypes.CDLL(os.path.join(drv, "XboxComm64.dll"))
except OSError as e:
    finish(False, "cannot load XboxComm64.dll: %s" % e)

CB = ctypes.CFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_uint)
dll.InitXboxMonitorRes.argtypes = [ctypes.c_char_p, ctypes.c_bool, CB, ctypes.c_uint]
dll.InitXboxMonitorRes.restype = ctypes.c_int
dll.IsCurrentUsbCanWrite.restype = ctypes.c_bool
dll.WriteData2Usb.argtypes = [ctypes.c_void_p, ctypes.c_uint]
dll.WriteData2Usb.restype = ctypes.c_bool

cb = CB(lambda p, ctx: True)  # we only send; keep a reference so it is not collected
res = dll.InitXboxMonitorRes(sys_path.encode(), False, cb, 0)
if res == 5:
    finish(False, "access denied starting the Xbox 360 filter driver: this helper must run as administrator.")
if res != 0:
    finish(False, "the Xbox 360 filter driver did not start (code %d). Close Flydigi Space Station and its service." % res)
time.sleep(1.0)
if not dll.IsCurrentUsbCanWrite():
    finish(False, "the filter driver cannot write to the pad (is it wired, in USB mode, and in XInput mode?)")

buf = bytearray(15)
buf[0], buf[1] = 0xA5, 0x17
arr = (ctypes.c_ubyte * 15).from_buffer(buf)
if not dll.WriteData2Usb(ctypes.addressof(arr), 15):
    finish(False, "the switch frame could not be written")
time.sleep(2.0)
finish(True)
