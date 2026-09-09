import { spawn } from 'node:child_process'

export function supervisorReloadArguments(uid: number, label: string): string[] {
  if (!Number.isSafeInteger(uid) || uid < 0 || !/^[A-Za-z0-9._-]+$/.test(label)) {
    throw new Error('Invalid supervisor launchd identity')
  }
  return ['kickstart', '-k', `gui/${uid}/${label}`]
}

/** Explicit demand also works when launchd has suspended KeepAlive respawns. */
export function requestMacosSupervisorReload(label: string): void {
  const args = supervisorReloadArguments(process.getuid!(), label)
  // launchd owns the replacement. Detach the requester so terminating this
  // supervisor cannot terminate the request before launchd processes it.
  const request = spawn('/bin/launchctl', args, { detached: true, stdio: 'ignore' })
  request.on('error', error => {
    process.stderr.write(`[gateway-update] supervisor reload request failed: ${error.message}\n`)
  })
  request.on('exit', code => {
    if (code !== null && code !== 0) {
      process.stderr.write(`[gateway-update] supervisor reload request exited ${code}; current supervisor remains available\n`)
    }
  })
  request.unref()
}
