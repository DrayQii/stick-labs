"""Unpack a .NET single-file bundle (an app published with PublishSingleFile) into a folder, so ILSpy can open the
managed DLLs inside. Research helper; reads the bundle manifest only, runs nothing from the file.

Usage: python dotnet-bundle-extract.py <bundle.exe> <out-folder>

Format (dotnet/runtime src/installer/managed/Microsoft.NET.HostModel/Bundle): the apphost holds the bundle
signature (32 bytes) right after an int64 manifest offset. Manifest: uint32 major, uint32 minor, int32 file count,
string bundle id, then (major >= 2) deps.json offset/size, runtimeconfig offset/size and uint64 flags, then per file:
int64 offset, int64 size, (major >= 6) int64 compressed size (0 = stored), uint8 type, string relative path.
Strings are 7-bit-length-prefixed UTF-8. Compressed entries are raw Deflate.
"""
import os
import struct
import sys
import zlib

SIG = bytes([0x8B, 0x12, 0x02, 0xB9, 0x6A, 0x61, 0x20, 0x38, 0x72, 0x7B, 0x93, 0x02, 0x14, 0xD7, 0xA0, 0x32,
             0x13, 0xF5, 0xB9, 0xE6, 0xEF, 0xAE, 0x33, 0x18, 0xEE, 0x3B, 0x2D, 0xCE, 0x24, 0xB3, 0x6A, 0xAE])  # SHA-256 of ".net core bundle" (Bundler.cs)


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    src, out = sys.argv[1], sys.argv[2]
    data = open(src, "rb").read()
    at = data.find(SIG)
    if at < 8:
        sys.exit("no .NET bundle signature found: not a single-file bundle")
    pos = struct.unpack_from("<q", data, at - 8)[0]
    if pos <= 0 or pos >= len(data):
        sys.exit("bundle signature found but the manifest offset is empty (this is a plain apphost)")

    def u(fmt):
        nonlocal pos
        v = struct.unpack_from(fmt, data, pos)
        pos += struct.calcsize(fmt)
        return v[0]

    def string():
        nonlocal pos
        n, shift = 0, 0
        while True:
            b = data[pos]
            pos += 1
            n |= (b & 0x7F) << shift
            shift += 7
            if not b & 0x80:
                break
        s = data[pos:pos + n].decode("utf-8")
        pos += n
        return s

    major, minor, count = u("<I"), u("<I"), u("<i")
    bundle_id = string()
    if major >= 2:
        u("<q"); u("<q"); u("<q"); u("<q"); u("<Q")
    print("bundle v%d.%d, %d files, id %s" % (major, minor, count, bundle_id))
    for _ in range(count):
        off, size = u("<q"), u("<q")
        csize = u("<q") if major >= 6 else 0
        kind = u("<B")
        rel = string()
        blob = data[off:off + (csize or size)]
        if csize:
            blob = zlib.decompress(blob, -15)
        dest = os.path.join(out, *rel.replace("\\", "/").split("/"))
        os.makedirs(os.path.dirname(dest) or out, exist_ok=True)
        with open(dest, "wb") as f:
            f.write(blob)
        print("  %8d  %s" % (len(blob), rel))


if __name__ == "__main__":
    main()
