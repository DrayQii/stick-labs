"""Transport sidecar for Flydigi XInput-mode pads (Direwolf 4).

Loads Space Station's XboxComm64.dll and relays raw frames over JSON lines:

  stdin : {"id": 1, "op": "send", "hex": "a5 20 00 ..."}
  stdout: {"id": 1, "ok": true}                      reply to a request
          {"report": "<64 hex chars>"}               every 32-byte report whose
                                                     byte 14 is A5/5A
          {"ready": true} / {"fatal": "message"}     lifecycle

All protocol logic lives in src/shared/flydigi-xinput.ts; this file only moves
bytes. Needs an elevated process and Space Station + SpaceStationService closed
(they hold the filter). Never calls UninitXboxMonitorRes: that removes the
driver Space Station itself installed.
"""
import ctypes
import json
import os
import sys
import threading

SS = os.environ.get("FLYDIGI_SS_DIR", r"D:\Program Files\Flydigi Space Station")
DRV = os.path.join(SS, "driver")
SYS = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "drivers", "Xbox360Filter64.sys")
if not os.path.exists(SYS):
    SYS = os.path.join(DRV, "Xbox360Filter64.sys")

out_lock = threading.Lock()


def emit(obj):
    with out_lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def fatal(msg):
    emit({"fatal": msg})
    sys.exit(2)


if not os.path.exists(os.path.join(DRV, "XboxComm64.dll")):
    fatal("XboxComm64.dll not found in " + DRV + " (set FLYDIGI_SS_DIR)")

os.chdir(DRV)
try:
    dll = ctypes.CDLL(os.path.join(DRV, "XboxComm64.dll"))
except OSError as e:
    fatal("cannot load XboxComm64.dll: %s" % e)

CB = ctypes.CFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_uint)
dll.InitXboxMonitorRes.argtypes = [ctypes.c_char_p, ctypes.c_bool, CB, ctypes.c_uint]
dll.InitXboxMonitorRes.restype = ctypes.c_int
dll.IsCurrentUsbCanWrite.restype = ctypes.c_bool
dll.WriteData2Usb.argtypes = [ctypes.c_void_p, ctypes.c_uint]
dll.WriteData2Usb.restype = ctypes.c_bool


def on_data(p, ctx):
    if not p:
        return False
    raw = ctypes.string_at(p + 8, 32)  # PXBOX_DATA_ITEM: u64 pipe handle, byte[32]
    if raw[14] in (0xA5, 0x5A):
        emit({"report": raw.hex()})
    return True


cb = CB(on_data)  # keep a reference or the callback is collected

res = dll.InitXboxMonitorRes(SYS.encode(), False, cb, 0)
if res != 0:
    fatal("InitXboxMonitorRes returned %d (run elevated, close Space Station)" % res)

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        if req.get("op") == "send":
            data = bytes.fromhex(req["hex"])
            if not dll.IsCurrentUsbCanWrite():
                emit({"id": req.get("id"), "ok": False, "error": "filter cannot write to the pad (is it in USB mode?)"})
                continue
            arr = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
            ok = bool(dll.WriteData2Usb(ctypes.addressof(arr), len(data)))
            emit({"id": req.get("id"), "ok": ok})
        elif req.get("op") == "ping":
            emit({"id": req.get("id"), "ok": True, "canWrite": bool(dll.IsCurrentUsbCanWrite())})
        else:
            emit({"id": req.get("id"), "ok": False, "error": "unknown op"})
    except Exception as e:  # keep the relay alive on a bad line
        emit({"id": None, "ok": False, "error": str(e)})
