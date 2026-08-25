<!-- architecture:start -->
# Architecture & Implementation Notes

Full design doc: `docs/architecture.md`

## Project Purpose

Malink is a **secure multi-device ACP agent workspace**. A local Gateway runs
ACP-compatible coding agents while PWA and Android clients communicate through
Matrix using the signed, application-encrypted Malink Protocol (MLP/3).

## Current Architecture

The active product runtime is:

```text
PWA or Android native service
  -> signed/encrypted MLP/3 command
  -> Matrix project timeline
  -> MatrixMlp3GatewayRunner
  -> command journal / authorization
  -> TopicSession
  -> SemanticSessionRuntime
  -> AgentProvider / ACP
  -> ConversationEvent
  -> signed/encrypted MLP/3 event
  -> Matrix outbox and project timeline
  -> verified client projection
```

Matrix is durable transport, not execution authority. The transitional Telegram
channel remains in the tree while shared runtime code is extracted, but it is
not the target product architecture.

## Project Principles

- **意外错误优先于任务完成。** 在完成任务过程中如果出现任何意外错误——包括但不限于：模型调用失败、子代理调用失败/超时、执行环境问题、缺乏依赖、工具不存在——必须立即告知用户，不允许为了完成任务而默默绕过。可以将可行的绕过方案一并提供给用户选择，但必须先报告错误本身。
  - ❌ 错误示范：用户要求写入全局记忆，发现没有全局记忆机制后，不告知用户，直接写入本地文件当作"差不多"。
  - ❌ 错误示范：子代理超时被中断，不告知用户，默默换用其他工具继续推进任务。
  - ✅ 正确做法：先报告错误（"我没有全局记忆的写入能力"），再提出替代方案让用户选择（"我可以写入项目级 AGENTS.md，是否可以？"）。
- **Every change MUST be made in a git worktree.** Create a worktree on a feature branch before modifying any file. Never edit directly on `main` without explicit user approval.
- **Never merge without user approval.** After completing and testing changes in a worktree, present the diff and wait for explicit user confirmation before merging (cherry-pick, merge, or rebase) into the target branch.
- **Clean up after merge.** Once a worktree's changes are merged and confirmed, remove the worktree and delete the feature branch.

## Key Invariants

- **One Matrix project room maps to one fixed Gateway working directory.**
- **One Agent session maps to one Matrix thread and one active `TopicSession`.**
- **`SemanticSessionRuntime` is the execution core** for query, cancel, command, and finalize behavior.
- **Only authenticated MLP/3 commands mutate execution state.** Matrix membership,
  ordinary messages, edits, and redactions are not execution authority.
- **Commands are journaled before execution** and stable command IDs cannot execute twice.
- **Sensitive business data stays inside Malink application encryption.**
- **Gateway and client outboxes are the retry authorities** for their respective deliveries.
- **Clients persist raw events before verification/projection** and UI reads only the local projection.
- **Browser and native transports never own the same session simultaneously.**
- **`SessionRecord` is metadata only.** Runtime behavior belongs in `SemanticSessionRuntime`.

## Component Map

```text
src/
  gateway/
    matrix/                         # MLP/3 Gateway, journals, outboxes, Matrix transport
    pairing/                        # Gateway identity and device trust
    admin/                          # owner-only local administration socket

  channel/matrix/                  # Matrix ChannelPort implementations

  bridge/
    channelPort.ts                  # ChannelPort and TopicSession interfaces
    topicSession.ts                 # session -> SemanticSessionRuntime bridge

  runtime/
    semantic.ts                     # SessionInput and ConversationEvent model
    semanticSessionRuntime.ts       # active execution runtime
    providerAdapter.ts              # AgentEvent -> ConversationEvent
    sessionExtensions.ts            # optional local extension boundary

  providers/
    provider.ts                     # AgentProvider interface
    types.ts                        # AgentEvent model
    registry.ts                     # provider catalog and factories
    acp/                            # shared ACP provider implementation
    opencode/                       # opencode provider
    codebuddy/                      # codebuddy provider
    agent/                          # Cursor agent provider

  mcp/
    stdio.ts                        # active MCP stdio entry
    register.ts                     # shared MCP surface registration
    resources.ts                    # malink context resources/tools
    tools/                          # notify/session tools

apps/pwa/                            # browser/native-hosted UI and web transport
clients/android/                     # native host, Matrix service, local projection
packages/protocol/                   # MLP schemas and canonical encoding
packages/security/                   # signatures, encryption, replay protection
packages/native-bridge/              # native/WebView protocol
```

## Maintenance Guidance

Preserve the secure Matrix/MLP architecture. New behavior should fit one of the
existing ownership boundaries:

1. Runtime lifecycle belongs in `SemanticSessionRuntime`.
2. MLP command authorization, journaling, and Matrix delivery belong in the
   Matrix Gateway.
3. Protocol schemas and canonical wire rules belong in `packages/protocol`.
4. Cryptographic primitives and replay protection belong in `packages/security`.
5. Browser projection and presentation belong in `apps/pwa`.
6. Native lifecycle, secrets, Matrix sync, and background work belong in the
   Android service; the WebView is a presentation client.
7. Provider-specific event quirks belong in provider adapters.
8. Transitional Telegram behavior must stay isolated under its channel and
   legacy composition roots; do not make it authoritative for Matrix behavior.

Provider-specific ACP extension methods must stay inside the owning provider. The shared ACP client may expose generic `extMethod`/`extNotification` hooks, but Cursor-specific `cursor/*` behavior belongs in `src/providers/agent/cursorExtensions.ts`, not in `runtime/providerAdapter.ts` or channel rendering code.

<!-- architecture:end -->
