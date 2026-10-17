"""Experiment: read and set the Direwolf 4's polling rate over raw USB (WinUSB), without Space Station's driver.

Why: the rate is only exposed in XInput mode (045E:028E) and today Stick Labs reaches it through Space Station's
Xbox 360 filter driver (scripts/flydigi-xinput-helper.py). This script tries the same two frames as plain USB writes
through libusb's WinUSB backend:
  read  A5 50 07            -> the pad answers with a 32-byte report [14]=A5 [15]=50 [16]=07, rate code at [22]
  set   A5 50 0A <code>     -> no answer; the script reads the rate back afterwards
Codes: 1 = 1000 Hz, 2 = 500, 4 = 250, 8 = 125. Nothing else is ever sent (no mode switch, no config writes).

It does NOT work until Windows has bound the WinUSB driver to the pad instead of the Xbox driver (Zadig does that,
see docs/flydigi.md). While WinUSB is bound the pad is NOT an Xbox controller: games and Stick Labs' XInput features
lose it until the driver is rolled back (Device Manager -> uninstall the device with "Delete the driver software").

Needs: the pad wired, in XInput mode, WinUSB bound, Flydigi Space Station closed, python, and a libusb-1.0.dll
(pip install libusb-package, or FLYDIGI_LIBUSB=<full path to libusb-1.0.dll>).

Usage: python flydigi-winusb-probe.py --dump                list the pad's interfaces and endpoints, send nothing
       python flydigi-winusb-probe.py --read                read the stored rate
       python flydigi-winusb-probe.py --set CODE            set it (1, 2, 4 or 8) and read it back
Options: --iface N  --ep-in 0x81  --ep-out 0x01  --len 15  (default: the first interrupt IN/OUT endpoints found)
"""
import ctypes
import ctypes.util
import os
import sys
import time

VID, PID = 0x045E, 0x028E
HZ = {1: 1000, 2: 500, 4: 250, 8: 125}
ERR = {-1: "IO", -3: "ACCESS", -4: "NO_DEVICE", -5: "NOT_FOUND", -6: "BUSY", -7: "TIMEOUT",
       -8: "OVERFLOW", -9: "PIPE", -12: "NOT_SUPPORTED"}


def arg(name, default=None, flag=False):
    if name not in sys.argv:
        return default
    return True if flag else sys.argv[sys.argv.index(name) + 1]


DUMP = arg("--dump", False, True)
READ = arg("--read", False, True)
SET = arg("--set")
if not (DUMP or READ or SET is not None) or "-h" in sys.argv or "--help" in sys.argv:
    print(__doc__)
    sys.exit(0 if ("-h" in sys.argv or "--help" in sys.argv) else 2)
if SET is not None and int(SET, 0) not in HZ:
    print("rate code must be 1, 2, 4 or 8")
    sys.exit(2)


def name(rc):
    return "%s (%d)" % (ERR.get(rc, "error"), rc)


def die(msg):
    print(msg, file=sys.stderr)
    sys.stdout.flush()
    os._exit(2)


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
    die("libusb-1.0.dll not found (pip install libusb-package, or set FLYDIGI_LIBUSB to the full path of the dll).")


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
lib.libusb_init.argtypes = [ctypes.POINTER(ctypes.c_void_p)]
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
rc = lib.libusb_init(ctypes.byref(ctx))
if rc != 0:
    die("libusb_init failed: %s" % name(rc))

devs = ctypes.POINTER(ctypes.c_void_p)()
n = lib.libusb_get_device_list(ctx, ctypes.byref(devs))
if n < 0:
    die("device list failed: %s" % name(int(n)))
target = None
for i in range(n):
    d = DevDesc()
    if lib.libusb_get_device_descriptor(devs[i], ctypes.byref(d)) == 0 and (d.idVendor, d.idProduct) == (VID, PID):
        target = devs[i]
        break
if not target:
    die("No USB device 045E:028E visible to libusb. Is the pad wired, in XInput mode, and (for WinUSB) bound to the "
        "WinUSB driver? libusb only lists devices that WinUSB serves, so an Xbox-driver pad is not shown.")

# Interfaces and endpoints of the active configuration.
interfaces = []  # (iface, [(addr, attrs, maxpkt, interval)])
cfg = ctypes.POINTER(CfgDesc)()
rc = lib.libusb_get_active_config_descriptor(target, ctypes.byref(cfg))
if rc != 0:
    die("config descriptor: %s" % name(rc))
for i in range(cfg.contents.bNumInterfaces):
    itf = cfg.contents.interface[i]
    for a in range(itf.num_altsetting):
        s = itf.altsetting[a]
        eps = []
        print("interface %d alt %d class %02X/%02X/%02X endpoints %d" % (
            s.bInterfaceNumber, s.bAlternateSetting, s.bInterfaceClass, s.bInterfaceSubClass,
            s.bInterfaceProtocol, s.bNumEndpoints))
        for e in range(s.bNumEndpoints):
            ep = s.endpoint[e]
            kind = ["control", "isoch", "bulk", "interrupt"][ep.bmAttributes & 3]
            print("  ep 0x%02X %s %s maxpkt %d interval %d" % (
                ep.bEndpointAddress, "IN" if ep.bEndpointAddress & 0x80 else "OUT", kind, ep.wMaxPacketSize, ep.bInterval))
            eps.append((ep.bEndpointAddress, ep.bmAttributes, ep.wMaxPacketSize, ep.bInterval))
        if s.bAlternateSetting == 0:
            interfaces.append((s.bInterfaceNumber, eps))
lib.libusb_free_config_descriptor(cfg)
if DUMP:
    print("(--dump: nothing was sent)")
    sys.stdout.flush()
    os._exit(0)

IFACE = int(arg("--iface", "-1"), 0)
if IFACE < 0:
    IFACE = next((i for i, eps in interfaces if any(e[1] & 3 == 3 for e in eps)), interfaces[0][0] if interfaces else 0)
eps = dict(interfaces).get(IFACE, [])
EP_IN = int(arg("--ep-in", "-1"), 0)
EP_OUT = int(arg("--ep-out", "-1"), 0)
if EP_IN < 0:
    EP_IN = next((e[0] for e in eps if e[0] & 0x80 and e[1] & 3 == 3), 0x81)
if EP_OUT < 0:
    EP_OUT = next((e[0] for e in eps if not e[0] & 0x80 and e[1] & 3 == 3), 0x01)
LENGTH = int(arg("--len", "15"), 0)
print("using interface %d, IN 0x%02X, OUT 0x%02X, frame length %d" % (IFACE, EP_IN, EP_OUT, LENGTH))

h = ctypes.c_void_p()
rc = lib.libusb_open(target, ctypes.byref(h))
if rc == -12:
    die("libusb cannot open the pad: %s. The WinUSB driver is not bound to it (Zadig: select the pad, driver WinUSB, "
        "Replace Driver)." % name(rc))
if rc != 0:
    die("cannot open the pad: %s" % name(rc))
rc = lib.libusb_claim_interface(h, IFACE)
if rc != 0:
    die("cannot claim interface %d: %s (another program has the pad open)" % (IFACE, name(rc)))
print("claimed interface %d" % IFACE)
sys.stdout.flush()


def transfer_in(timeout_ms):
    buf = ctypes.create_string_buffer(64)
    got = ctypes.c_int(0)
    rc = lib.libusb_interrupt_transfer(h, EP_IN, buf, 64, ctypes.byref(got), timeout_ms)
    return rc, bytes(buf.raw[:got.value])


def drain(max_seconds=0.4):
    # The pad can stream input reports non-stop, so never wait for the queue to run dry.
    end = time.time() + max_seconds
    skipped = 0
    while time.time() < end:
        rc, data = transfer_in(30)
        if rc != 0 or not data:
            break
        skipped += 1
    print("drained %d queued reports" % skipped)


def send(cmd, *args):
    frame = bytearray(LENGTH)
    frame[0], frame[1] = 0xA5, cmd
    for i, a in enumerate(args):
        frame[2 + i] = a
    sent = ctypes.c_int(0)
    rc = lib.libusb_interrupt_transfer(h, EP_OUT, bytes(frame), len(frame), ctypes.byref(sent), 2000)
    print("sent %s -> %s, %d bytes" % (" ".join("%02X" % b for b in frame[:4]), name(rc) if rc else "ok", sent.value))
    if rc != 0:
        die("the write failed: %s (wrong endpoint? try --dump and --ep-out)" % name(rc))


def read_rate():
    drain()
    send(0x50, 0x07)
    end = time.time() + 3
    seen = 0
    while time.time() < end:
        rc, data = transfer_in(100)
        if rc == 0 and len(data) >= 23:
            seen += 1
            if data[14] == 0xA5 and data[15] == 0x50 and data[16] == 0x07:
                print("ack: " + " ".join("%02X" % b for b in data))
                return data[22]
        elif rc not in (0, -7):
            die("read failed: %s" % name(rc))
    print("no settings reply within 3 s (%d other reports seen)" % seen)
    return None


if SET is not None:
    code = int(SET, 0)
    print("setting %d Hz (code %d) ..." % (HZ[code], code))
    send(0x50, 0x0A, code)
    time.sleep(0.6)
rate = read_rate()
if rate is None:
    print("RESULT: no rate read back")
else:
    print("RESULT: rate code %d = %s Hz" % (rate, HZ.get(rate, "unknown")))
    if SET is not None:
        print("RESULT: %s" % ("matches what was set" if rate == int(SET, 0) else "does NOT match what was set"))
lib.libusb_release_interface(h, IFACE)
lib.libusb_close(h)
sys.stdout.flush()
os._exit(0)
