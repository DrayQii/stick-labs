"""Elevated helper for a Flydigi Direwolf 4 in XInput mode, over raw USB with UsbDk (no Space Station needed).

Same command line and result file as flydigi-xinput-helper.py, so Stick Labs can use either:
  python flydigi-usb-helper.py --out result.json [--set-rate CODE | --read-rate] [--to-dinput]
Codes: 1 = 1000 Hz, 2 = 500, 4 = 250, 8 = 125. Steps run in the order set/read rate, then switch to DInput (A5 17).
Writes {"ok", "error", "reportRate"} to --out. Exit code 0 on success.

How: libusb with the UsbDk backend. UsbDk (https://github.com/daynix/UsbDk, signed, one installer) lends the pad to
libusb while this runs and hands it back to the Xbox driver afterwards, so nothing is bound permanently and Space
Station is not needed. The pad applies a new rate by re-enumerating, so it is read back in a fresh libusb session.
Needs: UsbDk installed, python, libusb-1.0.dll (pip install libusb-package, or FLYDIGI_LIBUSB=<full dll path>),
the pad wired and in XInput mode (FN + D-pad Right), Xbox/Space Station apps that hold the pad closed.
Frames (verified, docs/flydigi.md): interrupt writes of 15 bytes to the first OUT endpoint, replies from the first IN.
"""
import ctypes
import ctypes.util
import json
import os
import subprocess
import sys
import time

VID, PID = 0x045E, 0x028E


def arg(name, has_value=True):
    if name not in sys.argv:
        return None
    return sys.argv[sys.argv.index(name) + 1] if has_value else True


OUT = arg("--out")
SET_RATE = arg("--set-rate")
READ_RATE = arg("--read-rate", False)
TO_DINPUT = arg("--to-dinput", False)
result = {"ok": False, "error": None, "reportRate": None}


def finish(ok, error=None):
    result["ok"], result["error"] = ok, error
    if OUT:
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(result, f)
    if not ok:
        print(error, file=sys.stderr)
    sys.stdout.flush()
    os._exit(0 if ok else 2)


class DevDesc(ctypes.Structure):
    _fields_ = [("bLength", ctypes.c_uint8), ("bDescriptorType", ctypes.c_uint8), ("bcdUSB", ctypes.c_uint16),
                ("bDeviceClass", ctypes.c_uint8), ("bDeviceSubClass", ctypes.c_uint8),
                ("bDeviceProtocol", ctypes.c_uint8), ("bMaxPacketSize0", ctypes.c_uint8),
                ("idVendor", ctypes.c_uint16), ("idProduct", ctypes.c_uint16), ("bcdDevice", ctypes.c_uint16),
                ("iManufacturer", ctypes.c_uint8), ("iProduct", ctypes.c_uint8),
                ("iSerialNumber", ctypes.c_uint8), ("bNumConfigurations", ctypes.c_uint8)]


class EpDesc(ctypes.Structure):
    _fields_ = [("bLength", ctypes.c_uint8), ("bDescriptorType", ctypes.c_uint8),
                ("bEndpointAddress", ctypes.c_uint8), ("bmAttributes", ctypes.c_uint8),
                ("wMaxPacketSize", ctypes.c_uint16), ("bInterval", ctypes.c_uint8),
                ("bRefresh", ctypes.c_uint8), ("bSynchAddress", ctypes.c_uint8),
                ("extra", ctypes.c_void_p), ("extra_length", ctypes.c_int)]


class IfDesc(ctypes.Structure):
    _fields_ = [("bLength", ctypes.c_uint8), ("bDescriptorType", ctypes.c_uint8),
                ("bInterfaceNumber", ctypes.c_uint8), ("bAlternateSetting", ctypes.c_uint8),
                ("bNumEndpoints", ctypes.c_uint8), ("bInterfaceClass", ctypes.c_uint8),
                ("bInterfaceSubClass", ctypes.c_uint8), ("bInterfaceProtocol", ctypes.c_uint8),
                ("iInterface", ctypes.c_uint8), ("endpoint", ctypes.POINTER(EpDesc)),
                ("extra", ctypes.c_void_p), ("extra_length", ctypes.c_int)]


class Interface(ctypes.Structure):
    _fields_ = [("altsetting", ctypes.POINTER(IfDesc)), ("num_altsetting", ctypes.c_int)]


class CfgDesc(ctypes.Structure):
    _fields_ = [("bLength", ctypes.c_uint8), ("bDescriptorType", ctypes.c_uint8),
                ("wTotalLength", ctypes.c_uint16), ("bNumInterfaces", ctypes.c_uint8),
                ("bConfigurationValue", ctypes.c_uint8), ("iConfiguration", ctypes.c_uint8),
                ("bmAttributes", ctypes.c_uint8), ("MaxPower", ctypes.c_uint8),
                ("interface", ctypes.POINTER(Interface)), ("extra", ctypes.c_void_p),
                ("extra_length", ctypes.c_int)]


def load_libusb():
    cands = [os.environ.get("FLYDIGI_LIBUSB")]
    try:
        import libusb_package  # type: ignore
        cands.append(str(libusb_package.get_library_path()))
    except Exception:
        pass
    cands += [ctypes.util.find_library("libusb-1.0"), "libusb-1.0.dll", "libusb-1.0"]
    for c in cands:
        if c:
            try:
                return ctypes.CDLL(c)
            except OSError:
                continue
    finish(False, "libusb-1.0.dll not found (pip install libusb-package, or set FLYDIGI_LIBUSB to the full path of the dll).")


if SET_RATE is not None and SET_RATE not in ("1", "2", "4", "8"):
    finish(False, "polling-rate code must be 1, 2, 4 or 8")

lib = load_libusb()
lib.libusb_init.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
lib.libusb_set_option.argtypes = [ctypes.c_void_p, ctypes.c_int]
lib.libusb_get_device_list.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))]
lib.libusb_get_device_list.restype = ctypes.c_ssize_t
lib.libusb_get_device_descriptor.argtypes = [ctypes.c_void_p, ctypes.POINTER(DevDesc)]
lib.libusb_get_active_config_descriptor.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.POINTER(CfgDesc))]
lib.libusb_free_config_descriptor.argtypes = [ctypes.POINTER(CfgDesc)]
lib.libusb_open.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
lib.libusb_close.argtypes = [ctypes.c_void_p]
lib.libusb_claim_interface.argtypes = [ctypes.c_void_p, ctypes.c_int]
lib.libusb_release_interface.argtypes = [ctypes.c_void_p, ctypes.c_int]
lib.libusb_interrupt_transfer.argtypes = [ctypes.c_void_p, ctypes.c_ubyte, ctypes.c_char_p, ctypes.c_int,
                                          ctypes.POINTER(ctypes.c_int), ctypes.c_uint]

ctx = ctypes.c_void_p()
if lib.libusb_init(ctypes.byref(ctx)) != 0:
    finish(False, "libusb_init failed.")
# LIBUSB_OPTION_USE_USBDK: must be set AFTER libusb_init on the context (before it, libusb 1.0.30 always fails).
if lib.libusb_set_option(ctx, 1) != 0:
    finish(False, "UsbDk is not available. Install UsbDk (github.com/daynix/UsbDk/releases) and restart Windows if its service is not running.")

target = None
deadline = time.time() + 12  # the pad can still be settling right after the app switched its mode
while target is None:
    devs = ctypes.POINTER(ctypes.c_void_p)()
    n = lib.libusb_get_device_list(ctx, ctypes.byref(devs))
    for i in range(max(n, 0)):
        d = DevDesc()
        if lib.libusb_get_device_descriptor(devs[i], ctypes.byref(d)) == 0 and (d.idVendor, d.idProduct) == (VID, PID):
            target = devs[i]
            break
    if target is None:
        if time.time() > deadline:
            finish(False, "The pad (045E:028E) is not visible through UsbDk. Is it wired and in XInput mode (FN + D-pad Right)?")
        time.sleep(0.25)

cfg = ctypes.POINTER(CfgDesc)()
if lib.libusb_get_active_config_descriptor(target, ctypes.byref(cfg)) != 0:
    finish(False, "could not read the pad's USB configuration.")
IFACE, EP_IN, EP_OUT = None, None, None
for i in range(cfg.contents.bNumInterfaces):
    s = cfg.contents.interface[i].altsetting[0]
    for e in range(s.bNumEndpoints):
        ep = s.endpoint[e]
        if ep.bmAttributes & 3 != 3:
            continue
        if IFACE is None:
            IFACE = s.bInterfaceNumber
        if s.bInterfaceNumber == IFACE:
            if ep.bEndpointAddress & 0x80 and EP_IN is None:
                EP_IN = ep.bEndpointAddress
            elif not ep.bEndpointAddress & 0x80 and EP_OUT is None:
                EP_OUT = ep.bEndpointAddress
lib.libusb_free_config_descriptor(cfg)
if IFACE is None or EP_IN is None or EP_OUT is None:
    finish(False, "the pad has no interrupt IN/OUT endpoint pair; this is not the expected XInput layout.")

h = ctypes.c_void_p()
if lib.libusb_open(target, ctypes.byref(h)) != 0:
    finish(False, "UsbDk could not open the pad. Run as administrator and close Space Station and the Xbox app.")
if lib.libusb_claim_interface(h, IFACE) != 0:
    finish(False, "another program has the pad open (close Space Station, the Xbox app and games).")


def transfer_in(timeout_ms):
    buf = ctypes.create_string_buffer(64)
    got = ctypes.c_int(0)
    rc = lib.libusb_interrupt_transfer(h, EP_IN, buf, 64, ctypes.byref(got), timeout_ms)
    return rc, bytes(buf.raw[:got.value])


def send(cmd, *args):
    frame = bytearray(15)
    frame[0], frame[1] = 0xA5, cmd
    for i, a in enumerate(args):
        frame[2 + i] = a
    sent = ctypes.c_int(0)
    rc = lib.libusb_interrupt_transfer(h, EP_OUT, bytes(frame), len(frame), ctypes.byref(sent), 2000)
    if rc != 0:
        finish(False, "writing to the pad failed (libusb error %d)." % rc)


def read_rate():
    end = time.time() + 0.4  # the pad streams input non-stop; skip what is queued, but never wait for it to run dry
    while time.time() < end:
        rc, data = transfer_in(30)
        if rc != 0 or not data:
            break
    send(0x50, 0x07)
    end = time.time() + 3
    while time.time() < end:
        rc, data = transfer_in(100)
        if rc == 0 and len(data) >= 23 and data[14] == 0xA5 and data[15] == 0x50 and data[16] == 0x07:
            return data[22]
        if rc not in (0, -7):
            finish(False, "reading from the pad failed (libusb error %d)." % rc)
    finish(False, "the pad did not answer the settings read.")


if SET_RATE is not None:
    code = int(SET_RATE)
    send(0x50, 0x0A, code)
    # The pad applies the rate by changing its USB descriptor and re-enumerating, which kills this handle:
    # read it back in a fresh libusb session once it is back.
    lib.libusb_close(h)
    time.sleep(4)
    res_file = (OUT or "usb-helper") + ".verify"
    subprocess.run([sys.executable, os.path.abspath(__file__), "--read-rate", "--out", res_file], check=False)
    try:
        with open(res_file, encoding="utf-8") as f:
            back = json.load(f)
        os.remove(res_file)
    except Exception:
        back = {"ok": False, "error": "could not read the rate back after the pad re-enumerated"}
    if not back.get("ok"):
        finish(False, back.get("error"))
    result["reportRate"] = back.get("reportRate")
    if result["reportRate"] != code:
        finish(False, "the pad reports polling-rate code %s after setting %s" % (result["reportRate"], code))
    if TO_DINPUT:  # the old handle is dead, so the switch runs in its own fresh session
        sw = subprocess.run([sys.executable, os.path.abspath(__file__), "--to-dinput"], check=False)
        if sw.returncode != 0:
            finish(False, "the switch to DInput failed after the rate was applied.")
    finish(True)

if READ_RATE:
    result["reportRate"] = read_rate()
if TO_DINPUT:
    send(0x17)
    time.sleep(2.0)
finish(True)
