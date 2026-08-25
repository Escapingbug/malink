import type {
  Mlp3Command,
  Mlp3CommandOperation,
  SignedMlp3Command,
} from '@malink/protocol'
import { verifyMlp3Command } from '@malink/security'
import type { MatrixGatewayTrustedDevice } from './config'
import {
  FileMlp3CommandJournal,
  type Mlp3CommandClaim,
} from './fileMlp3CommandJournal'

export class MatrixMlp3CommandAuthorizer {
  constructor(
    private readonly workspaceId: string,
    private readonly journal: FileMlp3CommandJournal,
  ) {}

  async authorize(
    signed: SignedMlp3Command,
    device: MatrixGatewayTrustedDevice,
    roomId: string,
    projectId: string,
    matrixEventId?: string,
    now = Date.now(),
  ): Promise<{ command: Mlp3Command; claim: Mlp3CommandClaim }> {
    if (!device.allowedRoomIds.includes(roomId)) {
      throw new Error('Malink device is not allowed in this project room')
    }
    if (device.certificateExpiresAt !== undefined && device.certificateExpiresAt <= now) {
      throw new Error('Malink device certificate has expired')
    }
    const command = await verifyMlp3Command(signed, device.publicKey, {
      workspaceId: this.workspaceId,
      projectId,
      deviceId: device.deviceId,
      certificateId: device.sequenceEpoch,
      allowedOperations: v3AllowedOperations(device.allowedOperations),
    })
    return {
      command,
      claim: await this.journal.claim(
        command,
        now,
        matrixEventId ? { roomId, matrixEventId } : undefined,
      ),
    }
  }
}

export function canApprovePrivilegedExecution(
  device: MatrixGatewayTrustedDevice | undefined,
): boolean {
  return device?.allowedOperations?.includes('privilege.approve') === true
}

function v3AllowedOperations(
  legacy: MatrixGatewayTrustedDevice['allowedOperations'],
): Mlp3CommandOperation[] | undefined {
  if (!legacy) return undefined
  const result = new Set<Mlp3CommandOperation>()
  for (const operation of legacy) {
    switch (operation) {
      case 'prompt': result.add('prompt.submit'); break
      case 'cancel': result.add('turn.cancel'); break
      case 'decision': result.add('decision.answer'); break
      case 'session.settings':
        result.add('session.update')
        result.add('notification.subscribe')
        result.add('notification.unsubscribe')
        break
      case 'session.create': result.add('session.create'); break
      case 'project.settings': result.add('project.update'); break
      case 'provider.sessions.list': result.add('provider.sessions.list'); break
      case 'provider.session.inspect': result.add('provider.session.inspect'); break
      case 'session.archive':
      case 'session.restore':
      case 'session.delete':
        result.add('session.set_lifecycle')
        break
      case 'device.invite':
        result.add('device.invitation.create')
        result.add('gateway.enrollment.invitation.create')
        result.add('gateway.enrollment.approve')
        break
      case 'privilege.approve': break
    }
  }
  return [...result]
}
