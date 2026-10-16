"""Experimental: switch a Flydigi Direwolf 4 from XInput to DInput over raw USB through UsbDk.

Sends the legacy A5 17 frame (see docs/flydigi.md) as a USB transfer via libusb's UsbDk
backend, instead of through Flydigi Space Station's Xbox 360 filter driver. UNVERIFIED on
hardware: which endpoint / transfer type the pad accepts is not known yet, so this has a
--dump mode (list descriptors) and options to try the candidates.

Needs: UsbDk installed (https://github.com/daynix/UsbDk/releases), a libusb-1.0.dll
(set FLYDIGI_LIBUSB to its path, `pip install libusb-package` also works, or have it on PATH),
the pad wired and in XInput mode (045E:028E). Space Station must not be running.
While UsbDk holds the device the Xbox driver is detached from it; it comes back on release.

Usage: python flydigi-usbdk-switch.py [--out result.json] [--dump]
           [--method int|ctrl] [--ep 0x01] [--iface 0] [--len 15]
           [--ctrl REQTYPE,REQUEST,VALUE,INDEX]   (with --method ctrl, hex or decimal)
Exit codes: 0 ok, 2 failure, 3 UsbDk/device access denied (an elevated run may work).
"""
import ctypes
import ctypes.util
import json
import os
import sys

VID, PID = 0x045E, 0x028E
LIBUSB_OPTION_USE_USBDK = 1
ERR = {-1: "IO", -3: "ACCESS", -4: "NO_DEVICE", -5: "NOT_FOUND", -6: "BUSY", -7: "TIMEOUT",
       -8: "OVERFLOW", -9: "PIPE", -12: "NOT_SUPPORTED"}


def arg(name, default=None, flag=False):
    if name not in sys.argv:
        return default
    return True if flag else sys.argv[sys.argv.index(name) + 1]


OUT = arg("--out")
DUMP = arg("--dump", False, True)
METHOD = arg("--method", "int")
EP = int(arg("--ep", "0x01"), 0)
IFACE = int(arg("--iface", "0"), 0)
LENGTH = int(arg("--len", "15"), 0)
CTRL = [int(x, 0) for x in arg("--ctrl", "0x41,0x17,0,0").split(",")]
result = {"ok": False, "error": None, "log": []}


def log(msg):
    result["log"].append(msg)
    print(msg)


def finish(ok, error=None, code=None):
    result["ok"], result["error"] = ok, error
    if OUT:
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(result, f)
    if not ok:
        print(error, file=sys.stderr)
    sys.stdout.flush()
    os._exit(0 if ok else (code or 2))


def name(rc):
    return "%s (%d)" % (ERR.get(rc, "error"), rc)


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
    finish(False, "libusb-1.0.dll not found (set FLYDIGI_LIBUSB, or pip install libusb-package).")


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


lib = load_libusb()
lib.libusb_set_option.argtypes = [ctypes.c_void_p, ctypes.c_int]
lib.libusb_init.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
lib.libusb_get_device_list.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))]
lib.libusb_get_device_list.restype = ctypes.c_ssize_t
lib.libusb_free_device_list.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_int]
lib.libusb_get_device_descriptor.argtypes = [ctypes.c_void_p, ctypes.POINTER(DevDesc)]
lib.libusb_get_active_config_descriptor.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.POINTER(CfgDesc))]
lib.libusb_free_config_descriptor.argtypes = [ctypes.POINTER(CfgDesc)]
lib.libusb_open.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)]
lib.libusb_close.argtypes = [ctypes.c_void_p]
lib.libusb_claim_interface.argtypes = [ctypes.c_void_p, ctypes.c_int]
lib.libusb_release_interface.argtypes = [ctypes.c_void_p, ctypes.c_int]
lib.libusb_interrupt_transfer.argtypes = [ctypes.c_void_p, ctypes.c_ubyte, ctypes.c_char_p, ctypes.c_int,
                                          ctypes.POINTER(ctypes.c_int), ctypes.c_uint]
lib.libusb_control_transfer.argtypes = [ctypes.c_void_p, ctypes.c_uint8, ctypes.c_uint8, ctypes.c_uint16,
                                        ctypes.c_uint16, ctypes.c_char_p, ctypes.c_uint16, ctypes.c_uint]

rc = lib.libusb_set_option(None, LIBUSB_OPTION_USE_USBDK)
if rc != 0:
    finish(False, "libusb could not enable the UsbDk backend: %s. Is UsbDk installed (and this libusb 1.0.21+)?" % name(rc))
ctx = ctypes.c_void_p()
rc = lib.libusb_init(ctypes.byref(ctx))
if rc != 0:
    finish(False, "libusb_init failed: %s" % name(rc), 3 if rc == -3 else 2)

devs = ctypes.POINTER(ctypes.c_void_p)()
n = lib.libusb_get_device_list(ctx, ctypes.byref(devs))
if n < 0:
    finish(False, "device list failed: %s" % name(int(n)), 3 if n == -3 else 2)
target = None
for i in range(n):
    d = DevDesc()
    if lib.libusb_get_device_descriptor(devs[i], ctypes.byref(d)) == 0 and (d.idVendor, d.idProduct) == (VID, PID):
        target = devs[i]
        break
if not target:
    finish(False, "no 045E:028E found through UsbDk (pad wired and in XInput mode? Space Station closed?)")

if DUMP:
    cfg = ctypes.POINTER(CfgDesc)()
    rc = lib.libusb_get_active_config_descriptor(target, ctypes.byref(cfg))
    if rc != 0:
        log("config descriptor: %s" % name(rc))
    else:
        for i in range(cfg.contents.bNumInterfaces):
            itf = cfg.contents.interface[i]
            for a in range(itf.num_altsetting):
                s = itf.altsetting[a]
                log("interface %d alt %d class %02X/%02X/%02X endpoints %d" % (
                    s.bInterfaceNumber, s.bAlternateSetting, s.bInterfaceClass, s.bInterfaceSubClass,
                    s.bInterfaceProtocol, s.bNumEndpoints))
                for e in range(s.bNumEndpoints):
                    ep = s.endpoint[e]
                    kind = ["control", "isoch", "bulk", "interrupt"][ep.bmAttributes & 3]
                    log("  ep 0x%02X %s %s maxpkt %d interval %d" % (
                        ep.bEndpointAddress, "IN" if ep.bEndpointAddress & 0x80 else "OUT", kind,
                        ep.wMaxPacketSize, ep.bInterval))
        lib.libusb_free_config_descriptor(cfg)

h = ctypes.c_void_p()
rc = lib.libusb_open(target, ctypes.byref(h))
if rc != 0:
    finish(False, "cannot open the pad through UsbDk: %s" % name(rc), 3 if rc == -3 else 2)
if DUMP:
    lib.libusb_close(h)
    finish(True)

rc = lib.libusb_claim_interface(h, IFACE)
if rc != 0:
    lib.libusb_close(h)
    finish(False, "cannot claim interface %d: %s" % (IFACE, name(rc)), 3 if rc == -3 else 2)

frame = bytearray(LENGTH)
frame[0], frame[1] = 0xA5, 0x17
buf = bytes(frame)
sent = ctypes.c_int(0)
if METHOD == "ctrl":
    rt, rq, val, idx = (CTRL + [0, 0, 0, 0])[:4]
    rc = lib.libusb_control_transfer(h, rt, rq, val, idx, buf, len(buf), 2000)
    sent.value = rc if rc >= 0 else 0
    rc = 0 if rc >= 0 else rc
else:
    rc = lib.libusb_interrupt_transfer(h, EP, buf, len(buf), ctypes.byref(sent), 2000)
log("transfer %s ep 0x%02X len %d -> %s, %d bytes" % (METHOD, EP, len(buf), name(rc) if rc else "ok", sent.value))
lib.libusb_release_interface(h, IFACE)
lib.libusb_close(h)
lib.libusb_free_device_list(devs, 1)
if rc != 0:
    finish(False, "the transfer failed: %s" % name(rc))
finish(True)
