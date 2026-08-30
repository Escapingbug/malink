import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, rename, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { canonicalJson } from '@malink/protocol'
import {
  parseMlp3CommandJournalEntry,
  mlp3CommandFingerprint,
  mlp3CommandKey,
  type Mlp3CommandTerminal,
} from './fileMlp3CommandJournal.js'

export type Mlp3CommandJournalDuplicateTerminal = {
  commandId: string
  preservedTerminalLine: number
  preservedTerminalEventId: string
  duplicateTerminalLine: number
  duplicateTerminalEventId: string
  duplicateOutcome: Mlp3CommandTerminal['outcome']
  duplicateDeliveryLine?: number
}

export type Mlp3CommandJournalRepairPlan = {
  lineCount: number
  duplicateTerminals: Mlp3CommandJournalDuplicateTerminal[]
  removedLines: number[]
}

export type Mlp3CommandJournalRepairResult = Mlp3CommandJournalRepairPlan & {
  journalPath: string
  backupPath: string
  auditPath: string
  beforeSha256: string
  afterSha256: string
}

type ReplayState = {
  commandId: string
  fingerprint: string
  status: 'accepted' | 'dispatched' | 'terminal'
  terminal?: Mlp3CommandTerminal
  terminalLine?: number
  deliveryLine?: number
  pendingDuplicateIndexes: number[]
}

export function planMlp3CommandJournalRepair(text: string): Mlp3CommandJournalRepairPlan {
  const states = new Map<string, ReplayState>()
  const duplicateTerminals: Mlp3CommandJournalDuplicateTerminal[] = []
  const removedLines = new Set<number>()
  let headers = 0
  const lines = text.split(/\r?\n/u)
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1
    if (!line.trim()) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      throw new Error(`Corrupt MLP/3 command journal at line ${lineNumber}`)
    }
    const entry = parseMlp3CommandJournalEntry(raw, lineNumber)
    if (entry.kind === 'journal') {
      headers += 1
      if (headers > 1) throw new Error('Duplicate MLP/3 command journal header')
      continue
    }
    if (entry.kind === 'accepted') {
      if (states.has(entry.key)) {
        throw new Error(`Duplicate MLP/3 command acceptance at line ${lineNumber}`)
      }
      if (
        entry.key !== mlp3CommandKey(entry.command)
        || entry.fingerprint !== mlp3CommandFingerprint(entry.command)
      ) {
        throw new Error(`Invalid MLP/3 command acceptance binding at line ${lineNumber}`)
      }
      states.set(entry.key, {
        commandId: entry.command.commandId,
        fingerprint: entry.fingerprint,
        status: 'accepted',
        pendingDuplicateIndexes: [],
      })
      continue
    }
    const state = states.get(entry.key)
    if (!state || state.fingerprint !== entry.fingerprint) {
      throw new Error(`Orphaned MLP/3 command transition at line ${lineNumber}`)
    }
    if (entry.kind === 'dispatched') {
      if (state.status !== 'accepted') {
        throw new Error(`Invalid MLP/3 dispatched transition at line ${lineNumber}`)
      }
      state.status = 'dispatched'
      continue
    }
    if (entry.kind === 'terminal') {
      if (state.status !== 'terminal') {
        state.status = 'terminal'
        state.terminal = entry.terminal
        state.terminalLine = lineNumber
        continue
      }
      const identicalUndelivered = state.deliveryLine === undefined
        && canonicalJson(state.terminal) === canonicalJson(entry.terminal)
      if (state.deliveryLine === undefined && !identicalUndelivered) {
        throw new Error(
          `Conflicting MLP/3 terminal transition at line ${lineNumber} is not safely repairable: `
          + 'the first terminal result was not durably delivered.',
        )
      }
      removedLines.add(lineNumber)
      duplicateTerminals.push({
        commandId: state.commandId,
        preservedTerminalLine: state.terminalLine!,
        preservedTerminalEventId: state.terminal!.eventId,
        duplicateTerminalLine: lineNumber,
        duplicateTerminalEventId: entry.terminal.eventId,
        duplicateOutcome: entry.terminal.outcome,
      })
      if (!identicalUndelivered) {
        state.pendingDuplicateIndexes.push(duplicateTerminals.length - 1)
      }
      continue
    }
    if (state.status !== 'terminal') {
      throw new Error(`Invalid MLP/3 terminal delivery at line ${lineNumber}`)
    }
    if (state.deliveryLine === undefined) {
      state.deliveryLine = lineNumber
      continue
    }
    const duplicateIndex = state.pendingDuplicateIndexes.shift()
    if (duplicateIndex === undefined) {
      throw new Error(`Duplicate MLP/3 terminal delivery at line ${lineNumber}`)
    }
    removedLines.add(lineNumber)
    duplicateTerminals[duplicateIndex]!.duplicateDeliveryLine = lineNumber
  }
  if (headers !== 1) {
    throw new Error('MLP/3 command journal is missing its generation header')
  }
  return {
    lineCount: lines.length,
    duplicateTerminals,
    removedLines: [...removedLines].sort((left, right) => left - right),
  }
}

export async function repairMlp3CommandJournal(
  journalPath: string,
): Promise<Mlp3CommandJournalRepairResult> {
  const original = await readFile(journalPath, 'utf8')
  const plan = planMlp3CommandJournalRepair(original)
  if (plan.duplicateTerminals.length === 0) {
    throw new Error('The MLP/3 command journal has no safely repairable duplicate terminals')
  }
  const removed = new Set(plan.removedLines)
  const repaired = original
    .split(/\r?\n/u)
    .filter((_line, index) => !removed.has(index + 1))
    .join('\n')
  const cleanPlan = planMlp3CommandJournalRepair(repaired)
  if (cleanPlan.duplicateTerminals.length > 0 || cleanPlan.removedLines.length > 0) {
    throw new Error('The repaired MLP/3 command journal did not pass replay validation')
  }
  const beforeSha256 = sha256(original)
  const afterSha256 = sha256(repaired)
  const suffix = `${new Date().toISOString().replace(/[:.]/gu, '')}-${randomUUID()}`
  const backupPath = `${journalPath}.backup-${suffix}`
  const auditPath = `${backupPath}.repair.json`
  const temporaryPath = `${journalPath}.repair-${suffix}`
  const mode = (await stat(journalPath)).mode & 0o777
  const result: Mlp3CommandJournalRepairResult = {
    ...plan,
    journalPath,
    backupPath,
    auditPath,
    beforeSha256,
    afterSha256,
  }
  await writeExclusiveDurable(backupPath, original, mode)
  await writeExclusiveDurable(temporaryPath, repaired, mode)
  // Write the audit intent before the atomic replacement. If replacement is
  // interrupted, support can compare the live hash with before/afterSha256;
  // a successful replacement can therefore never exist without its report.
  await writeExclusiveDurable(
    auditPath,
    `${JSON.stringify({
      kind: 'malink.mlp3-command-journal-repair',
      version: 1,
      preparedAt: Date.now(),
      ...result,
    }, null, 2)}\n`,
    0o600,
  )
  await rename(temporaryPath, journalPath)
  await syncDirectory(dirname(journalPath))
  return result
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function writeExclusiveDurable(path: string, content: string, mode: number): Promise<void> {
  const handle = await open(path, 'wx', mode)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
