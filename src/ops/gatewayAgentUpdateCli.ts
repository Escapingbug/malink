import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { GatewayUpdateSupervisorClient } from './gatewayUpdateSupervisorServer.js'

export async function runGatewayAgentUpdateCli(argv: readonly string[]): Promise<unknown> {
  const [command, ...arguments_] = argv
  const socketPath = requiredArgument(arguments_, 'socket')
  const releaseId = requiredArgument(arguments_, 'release-id')
  const client = new GatewayUpdateSupervisorClient(socketPath, 30 * 60_000)
  switch (command) {
    case 'instruction':
      return client.agentInstruction(releaseId)
    case 'finish':
    case 'submit':
      return client.submitAgentRelease(releaseId)
    case 'status':
      return client.status()
    default:
      throw new Error(`Unsupported Gateway Agent update command: ${command ?? '(missing)'}`)
  }
}

function requiredArgument(argv: readonly string[], name: string): string {
  const index = argv.indexOf(`--${name}`)
  const value = index >= 0 ? argv[index + 1] : undefined
  if (!value) throw new Error(`Missing --${name}`)
  return value
}

export function isGatewayAgentUpdateCliEntry(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false
  try {
    return realpathSync(new URL(moduleUrl)) === realpathSync(argvPath)
  } catch {
    return moduleUrl === pathToFileURL(argvPath).href
  }
}

if (isGatewayAgentUpdateCliEntry(import.meta.url, process.argv[1])) {
  await runGatewayAgentUpdateCli(process.argv.slice(2))
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
