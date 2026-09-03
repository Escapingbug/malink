import type {
  Mlp3Command,
  Mlp3CommandOperation,
  SignedMlp3Command,
} from '@malink/protocol'
import { verifyMlp3Command } from '@malink/security'
import type { MatrixGatewayTrustedDevice } from './config'
import {
  type Mlp3CommandClaim,
  type Mlp3CommandJournal,
} from './fileMlp3CommandJournal'

export type Mlp3CommandAuthorizationRejection = {
  code: 'room_not_allowed' | 'certificate_expired' | 'operation_not_allowed'
  message: string
  retryable: false
}

export type Mlp3CommandAuthorization = {
  command: Mlp3Command
  claim: Mlp3CommandClaim
  rejection?: Mlp3CommandAuthorizationRejection
}

/**
 * `device.invite` is the pairing-time marker for a full Workspace member: a
 * device that can add another full member already dominates every ordinary
 * command capability. Keep the wire field for compatibility, but let such a
 * member inherit ordinary operations introduced by later MLP/3 versions.
 *
 * Root privilege approval remains outside this list and is checked directly
 * against the signed certificate by canApprovePrivilegedExecution().
 */
const CURRENT_WORKSPACE_MEMBER_OPERATIONS = [
  'session.create',
  'prompt.submit',
  'turn.cancel',
  'decision.answer',
  'artifact.materialize',
  'session.update',
  'session.set_lifecycle',
  'project.create',
  'project.update',
  'project.delete',
  'provider.sessions.list',
  'provider.session.inspect',
  'provider.history.materialize',
  'device.invitation.create',
  'gateway.enrollment.invitation.create',
  'gateway.enrollment.approve',
  'gateway.enrollment.cancel',
  'gateway.profile.update',
  'gateway.retire',
  'notification.subscribe',
  'notification.unsubscribe',
  'gateway.update.stage',
  'gateway.update.apply',
  'gateway.update.status',
] as const satisfies readonly Mlp3CommandOperation[]

type MissingWorkspaceMemberOperation = Exclude<
  Mlp3CommandOperation,
  (typeof CURRENT_WORKSPACE_MEMBER_OPERATIONS)[number]
>
const ALL_WORKSPACE_MEMBER_OPERATIONS_ARE_LISTED: MissingWorkspaceMemberOperation extends never
  ? true
  : never = true
void ALL_WORKSPACE_MEMBER_OPERATIONS_ARE_LISTED

export class MatrixMlp3CommandAuthorizer {
  constructor(
    private readonly workspaceId: string,
    private readonly journal: Mlp3CommandJournal,
  ) {}

  async authorize(
    signed: SignedMlp3Command,
    device: MatrixGatewayTrustedDevice,
    roomId: string,
    projectId: string,
    matrixEventId?: string,
    now = Date.now(),
  ): Promise<Mlp3CommandAuthorization> {
    // Verify the signature and immutable execution bindings before returning a
    // policy rejection. This lets the Gateway safely acknowledge a known
    // device's denied command without reflecting attacker-controlled IDs.
    const command = await verifyMlp3Command(signed, device.publicKey, {
      workspaceId: this.workspaceId,
      projectId,
      deviceId: device.deviceId,
      certificateId: device.sequenceEpoch,
    })
    const allowedOperations = v3AllowedOperations(device.allowedOperations)
    const rejection = !device.allowedRoomIds.includes(roomId)
      ? {
          code: 'room_not_allowed' as const,
          message: 'Malink device is not allowed in this project room',
          retryable: false as const,
        }
      : device.certificateExpiresAt !== undefined && device.certificateExpiresAt <= now
        ? {
            code: 'certificate_expired' as const,
            message: 'Malink device certificate has expired',
            retryable: false as const,
          }
        : allowedOperations !== undefined && !allowedOperations.includes(command.operation)
          ? {
              code: 'operation_not_allowed' as const,
              message: `Malink device is not allowed to run ${command.operation}`,
              retryable: false as const,
            }
          : undefined
    return {
      command,
      claim: await this.journal.claim(
        command,
        now,
        matrixEventId ? { roomId, matrixEventId } : undefined,
      ),
      ...(rejection ? { rejection } : {}),
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
  if (legacy.includes('device.invite')) {
    return [...CURRENT_WORKSPACE_MEMBER_OPERATIONS]
  }
  const result = new Set<Mlp3CommandOperation>()
  for (const operation of legacy) {
    switch (operation) {
      case 'prompt': result.add('prompt.submit'); break
      case 'cancel': result.add('turn.cancel'); break
      case 'decision': result.add('decision.answer'); break
      case 'artifact.materialize': result.add('artifact.materialize'); break
      case 'session.settings':
        result.add('session.update')
        result.add('notification.subscribe')
        result.add('notification.unsubscribe')
        break
      case 'session.create': result.add('session.create'); break
      case 'project.create': result.add('project.create'); break
      case 'project.settings':
        result.add('project.update')
        result.add('project.delete')
        break
      case 'provider.sessions.list': result.add('provider.sessions.list'); break
      case 'provider.session.inspect': result.add('provider.session.inspect'); break
      case 'provider.history.materialize': result.add('provider.history.materialize'); break
      case 'session.archive':
      case 'session.restore':
      case 'session.delete':
        result.add('session.set_lifecycle')
        break
      case 'device.invite':
        result.add('device.invitation.create')
        result.add('gateway.enrollment.invitation.create')
        result.add('gateway.enrollment.approve')
        result.add('gateway.enrollment.cancel')
        result.add('gateway.profile.update')
        result.add('gateway.retire')
        break
      case 'privilege.approve': break
      case 'gateway.update':
        result.add('gateway.update.stage')
        result.add('gateway.update.apply')
        result.add('gateway.update.status')
        break
    }
  }
  return [...result]
}
