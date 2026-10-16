/**
 * Flydigi identify session: V2 (VID 0x37D7, usage page 0xFFA0) and V1
 * (VID 0x04B4 PID 0x2412, interface 2 — incl. the Direwolf 4 in DInput mode).
 *
 * READ-ONLY: V2 check-architecture, get-info and get-status; V1 get-info
 * (0xEC) — the handshakes SDL and Space Station run on these pads. No write path exists here; tuning
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
  fdParseV1Info,
  fdV1GetInfo,
  FD_V1_CMD_GET_INFO,
  type FdIdentifyResult,
  type FdV1Info
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

/** V1 get-info: Vader 2-era pads can take many retries to answer (SDL). */
function askV1(handle: HIDInstance, product: string | undefined): Promise<FdV1Info | null> {
  return new Promise((resolve) => {
    let done = false
    let tries = 0
    const finish = (v: FdV1Info | null): void => {
      if (done) return
      done = true
      clearInterval(retry)
      clearTimeout(timer)
      handle.removeListener('data', onData)
      resolve(v)
    }
    const onData = (raw: Buffer): void => {
      const d = new Uint8Array(raw)
      if (d.length >= 32 && d[15] === FD_V1_CMD_GET_INFO) finish(fdParseV1Info(d, product))
    }
    const send = (): void => {
      tries++
      try {
        handle.write(Array.from(fdV1GetInfo()))
      } catch {
        /* SDL: this write occasionally fails — retry */
      }
    }
    handle.on('data', onData)
    const retry = setInterval(() => (tries < 10 ? send() : undefined), 150)
    const timer = setTimeout(() => finish(null), 1600)
    send()
  })
}

export async function fdIdentify(path: string): Promise<FdIdentifyResult> {
  const dev = lookup(path)
  if (!dev) throw new Error('flydigi: device path is no longer present')
  const fallbackName = fdNameFromProduct(dev.product) ?? dev.product ?? 'Flydigi controller'
  const base = { vendorId: dev.vendorId, productId: dev.productId }

  let handle: HIDInstance
  try {
    handle = new HIDModule.HID(path)
  } catch (e) {
    throw new Error(`flydigi: cannot open the pad (${(e as Error).message}). Close Flydigi Space Station and retry.`)
  }
  try {
    if (dev.vendorId !== FD_VID_V2) {
      // V1 (Cypress VID): report 0x05 + 0xEC, as Space Station's DInputProtocol sends.
      const v1 = await askV1(handle, dev.product)
      return { ...base, info: null, v1, modelName: v1?.modelName ?? fallbackName, thirdPartyAllowed: null }
    }
    const unnumbered = fdUsesUnnumberedReports(dev.vendorId, dev.productId)
    const arch = await ask(handle, fdCheckArchitecture(unnumbered), FD_CMD_CHECK_ARCH)
    const infoRaw = await ask(handle, fdGetInfo(unnumbered), FD_CMD_GET_INFO)
    const info = infoRaw ? fdParseInfo(infoRaw, arch ? fdIsNewArchitecture(arch) : false, dev.product) : null
    const statusRaw = await ask(handle, fdGetStatus(unnumbered), FD_CMD_GET_STATUS)
    return {
      ...base,
      info,
      v1: null,
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
