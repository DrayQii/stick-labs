"""Elevated helper for a Flydigi Direwolf 4 in XInput mode.

Talks through the Xbox 360 filter driver that Flydigi Space Station installed
(XboxComm64.dll). Stick Labs uses it for the two things the plain-HID (DInput)
path cannot do:
  * switch the pad XInput -> DInput (legacy frame A5 17), and
  * set / read the polling rate (A5 50 0A <code> / A5 50 07), which the Direwolf
    only exposes in XInput mode.
Everything else in Stick Labs is plain HID.

Needs: administrator rights, Flydigi Space Station installed (for its DLL and
driver) but NOT running, the pad wired, in USB mode and in XInput mode.

Usage: python flydigi-xinput-helper.py --out result.json
           [--set-rate CODE | --read-rate] [--to-dinput]
Codes: 1 = 1000 Hz, 2 = 500, 4 = 250, 8 = 125. Steps run in the order set/read
rate, then switch to DInput. Writes {"ok", "error", "reportRate"} to --out (an
elevated process cannot share stdout with its launcher). Exit code 0 on success.
"""
import ctypes
import json
import os
import sys
import threading
import time


def arg(name, has_value=True):
    if name not in sys.argv:
        return None
    if not has_value:
        return True
    return sys.argv[sys.argv.index(name) + 1]


OUT = arg("--out")
SET_RATE = arg("--set-rate")
READ_RATE = arg("--read-rate", False)
TO_DINPUT = arg("--to-dinput", False)
result = {"ok": False, "error": None, "reportRate": None}


def finish(ok, error=None):
    result["ok"] = ok
    result["error"] = error
    if OUT:
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(result, f)
    if not ok:
        print(error, file=sys.stderr)
    sys.stdout.flush()
    os._exit(0 if ok else 2)  # skip interpreter teardown with the driver callback live


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


if SET_RATE is not None and SET_RATE not in ("1", "2", "4", "8"):
    finish(False, "polling-rate code must be 1, 2, 4 or 8")

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

reports = []
lock = threading.Lock()


def on_data(p, ctx):
    if p:
        raw = ctypes.string_at(p + 8, 32)  # PXBOX_DATA_ITEM: u64 pipe handle, byte[32]
        if raw[14] == 0xA5:
            with lock:
                reports.append(raw)
    return True


cb = CB(on_data)  # keep a reference so it is not collected
res = dll.InitXboxMonitorRes(sys_path.encode(), False, cb, 0)
if res == 5:
    finish(False, "access denied starting the Xbox 360 filter driver: this helper must run as administrator.")
if res != 0:
    finish(False, "the Xbox 360 filter driver did not start (code %d). Close Flydigi Space Station and its service." % res)
time.sleep(1.0)
if not dll.IsCurrentUsbCanWrite():
    finish(False, "the filter driver cannot write to the pad (is it wired, in USB mode, and in XInput mode?)")


def send(cmd, *args):
    buf = bytearray(15)
    buf[0], buf[1] = 0xA5, cmd
    for i, a in enumerate(args):
        buf[2 + i] = a
    arr = (ctypes.c_ubyte * 15).from_buffer(buf)
    return bool(dll.WriteData2Usb(ctypes.addressof(arr), 15))


def read_rate():
    with lock:
        reports.clear()
    if not send(0x50, 0x07):
        finish(False, "the settings read could not be written")
    end = time.time() + 3
    while time.time() < end:
        with lock:
            hit = [r for r in reports if r[15] == 0x50 and r[16] == 0x07]
        if hit:
            return hit[-1][22]  # report-rate code, from Space Station's XInput parser
        time.sleep(0.02)
    finish(False, "the pad did not answer the settings read")


if SET_RATE is not None:
    code = int(SET_RATE)
    if not send(0x50, 0x0A, code):
        finish(False, "the polling-rate command could not be written")
    time.sleep(0.6)
    result["reportRate"] = read_rate()
    if result["reportRate"] != code:
        finish(False, "the pad reports polling-rate code %s after setting %s" % (result["reportRate"], code))
elif READ_RATE:
    result["reportRate"] = read_rate()

if TO_DINPUT:
    if not send(0x17):
        finish(False, "the switch-to-DInput frame could not be written")
    time.sleep(2.0)

finish(True)
