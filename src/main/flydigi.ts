/**
 * Flydigi identify session (VID 0x37D7, usage page 0xFFA0).
 *
 * READ-ONLY: check-architecture, get-info and get-status — the handshake
 * SDL runs on every Flydigi pad it opens. No write path exists here; tuning
 * stays locked until Space Station's config framing is captured and proven
 * with readback (docs/flydigi.md).
 */
import HIDModule, { type HID as HIDInstance } from 'node-hid'
import {
  FD_CMD_CHECK_ARCH,
  FD_CMD_GET_INFO,
  FD_CMD_GET_STATUS,
  FD_VID_V2,
  fdCheckArchitecture,
  fdFrame,
  fdGetInfo,
  fdGetStatus,
  fdIsNewArchitecture,
  fdNameFromProduct,
  fdParseInfo,
  fdParseThirdPartyAllowed,
  fdUsesUnnumberedReports,
  type FdIdentifyResult
} from '../shared/flydigi'


const REPLY_TIMEOUT_MS = 400

function lookup(path: string): { vendorId: number; productId: number; product?: string } | null {
  try {
    const d = HIDModule.devices().find((x) => x.path === path)
    return d ? { vendorId: d.vendorId, productId: d.productId, product: d.product } : null
  } catch {
    return null
  }
}

/** Write one command and wait for the reply carrying the same command byte. */
function ask(handle: HIDInstance, report: Uint8Array, cmd: number): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    let done = false
    const finish = (v: Uint8Array | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      handle.removeListener('data', onData)
      resolve(v)
    }
    const onData = (raw: Buffer): void => {
      const f = fdFrame(new Uint8Array(raw))
      if (f && f[2] === cmd) finish(new Uint8Array(f))
    }
    const timer = setTimeout(() => finish(null), REPLY_TIMEOUT_MS)
    handle.on('data', onData)
    try {
      handle.write(Array.from(report))
    } catch {
      finish(null)
    }
  })
}

export async function fdIdentify(path: string): Promise<FdIdentifyResult> {
  const dev = lookup(path)
  if (!dev) throw new Error('flydigi: device path is no longer present')
  const fallbackName = fdNameFromProduct(dev.product) ?? dev.product ?? 'Flydigi controller'
  const base = { vendorId: dev.vendorId, productId: dev.productId }

  // V1 pads (Cypress VID) predate the 5A A5 protocol — name only.
  if (dev.vendorId !== FD_VID_V2) return { ...base, info: null, modelName: fallbackName, thirdPartyAllowed: null }

  let handle: HIDInstance
  try {
    handle = new HIDModule.HID(path)
  } catch (e) {
    throw new Error(`flydigi: cannot open the pad (${(e as Error).message}). Close Flydigi Space Station and retry.`)
  }
  try {
    const unnumbered = fdUsesUnnumberedReports(dev.vendorId, dev.productId)
    const arch = await ask(handle, fdCheckArchitecture(unnumbered), FD_CMD_CHECK_ARCH)
    const infoRaw = await ask(handle, fdGetInfo(unnumbered), FD_CMD_GET_INFO)
    const info = infoRaw ? fdParseInfo(infoRaw, arch ? fdIsNewArchitecture(arch) : false, dev.product) : null
    const statusRaw = await ask(handle, fdGetStatus(unnumbered), FD_CMD_GET_STATUS)
    return {
      ...base,
      info,
      modelName: info?.modelName ?? fallbackName,
      thirdPartyAllowed: statusRaw ? fdParseThirdPartyAllowed(statusRaw) : null
    }
  } finally {
    try {
      handle.removeAllListeners()
      handle.close()
    } catch {
      /* already gone */
    }
  }
}
