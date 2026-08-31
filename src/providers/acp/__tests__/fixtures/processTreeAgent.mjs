import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const pidFile = process.env.ACP_TEST_DESCENDANT_PID_FILE
if (!pidFile) throw new Error('ACP_TEST_DESCENDANT_PID_FILE is required')

const descendant = spawn(process.execPath, [
  '-e',
  'setInterval(() => undefined, 1_000)',
], {
  stdio: 'ignore',
})
if (!descendant.pid) throw new Error('Failed to start ACP test descendant')
writeFileSync(pidFile, `${descendant.pid}\n`, { mode: 0o600 })

process.stdin.setEncoding('utf8')
let buffered = ''
process.stdin.on('data', chunk => {
  buffered += chunk
  while (true) {
    const newline = buffered.indexOf('\n')
    if (newline < 0) return
    const line = buffered.slice(0, newline)
    buffered = buffered.slice(newline + 1)
    if (!line.trim()) continue
    const request = JSON.parse(line)
    if (request.method !== 'initialize') continue
    if (process.env.ACP_TEST_HANG_INITIALIZE === '1') continue
    process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: request.id,
        result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: false },
        },
    })}\n`)
  }
})
process.stdin.on('end', () => process.exit(0))
