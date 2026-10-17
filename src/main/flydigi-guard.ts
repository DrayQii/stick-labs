/**
 * Leave-in-XInput helper. The app starts it (its own executable as plain node, detached, no window) once a
 * Direwolf 4 is seen in DInput mode. While the app runs it only checks, every second, that the app is alive. When
 * the app is gone (quit, crash, killed) and the pad may still be in DInput mode (state.armed), it switches the pad
 * back to XInput (05 ED); if the pad is unplugged it waits up to 30 minutes for it to come back. Then it exits.
 * Usage: flydigi-guard.js --parent PID --state FILE
 */
import { readGuardState, writeGuardState } from './flydigi-guard-state'
import { fxPadMode, fxSendToXInput } from './flydigi-switch'

const arg = (n: string): string | null => (process.argv.includes(n) ? (process.argv[process.argv.indexOf(n) + 1] ?? '') : null)
const parent = Number(arg('--parent'))
const stateFile = arg('--state') ?? ''
const LINGER_MS = 30 * 60 * 1000
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function main(): Promise<void> {
  if (!parent || !stateFile) return
  while (alive(parent)) {
    if (readGuardState(stateFile).pid !== parent) return // a newer app run owns the pad now
    await sleep(1000)
  }
  for (const end = Date.now() + LINGER_MS; Date.now() < end; ) {
    const s = readGuardState(stateFile)
    if (s.pid !== parent || !s.enabled || !s.armed) return
    const mode = fxPadMode()
    if (mode === 'xinput') {
      writeGuardState(stateFile, { ...s, armed: false })
      return
    }
    if (mode === 'dinput' && (await fxSendToXInput())) {
      writeGuardState(stateFile, { ...s, armed: false })
      return
    }
    await sleep(2000)
  }
}

main()
  .catch(() => undefined)
  .finally(() => process.exit(0))
