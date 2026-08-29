import type { PersistedStateClass } from '@malink/protocol'

export interface GatewayStateCatalogEntry {
    id: string
    stateClass: PersistedStateClass
    schemaVersion: number
    /** Every N denotes decoder/migration support for N -> N+1. */
    migrationFromVersions: ReadonlySet<number>
}

/**
 * Release inventory for every Gateway-owned persistent family. File/WAL
 * codecs retain their own atomic commit boundary; this catalog is the common
 * release gate that prevents a future schema bump from dropping an adjacent
 * migration or silently changing its safety class.
 */
export const GATEWAY_STATE_CATALOG: readonly GatewayStateCatalogEntry[] = Object.freeze([
    {
        // Retained in release manifests for rollback compatibility with
        // pre-MLP/3 releases. The active Gateway no longer opens this store.
        id: 'gateway-runtime-state',
        stateClass: 'durable-command',
        schemaVersion: 3,
        migrationFromVersions: new Set([1, 2]),
    },
    {
        // Project creation commits Matrix routing authority here. A rollback
        // release must understand every route accepted during probation.
        id: 'gateway-project-catalog',
        stateClass: 'durable-command',
        schemaVersion: 1,
        migrationFromVersions: new Set<number>(),
    },
    {
        id: 'command-replay-ledger',
        stateClass: 'security-critical',
        schemaVersion: 2,
        migrationFromVersions: new Set<number>(),
    },
    {
        id: 'timeline-key-ring',
        stateClass: 'security-critical',
        schemaVersion: 1,
        migrationFromVersions: new Set<number>(),
    },
    {
        id: 'matrix-login',
        stateClass: 'security-critical',
        schemaVersion: 1,
        migrationFromVersions: new Set<number>(),
    },
    {
        id: 'matrix-sdk-crypto-store',
        stateClass: 'security-critical',
        schemaVersion: 1,
        migrationFromVersions: new Set<number>(),
    },
    {
        id: 'matrix-state-outbox-wal',
        stateClass: 'durable-command',
        schemaVersion: 1,
        migrationFromVersions: new Set<number>(),
    },
    {
        id: 'matrix-delivery-outbox-wal',
        stateClass: 'durable-command',
        schemaVersion: 2,
        // The v2 decoder deliberately retains v1 single-recipient records.
        migrationFromVersions: new Set([1]),
    },
    {
        id: 'matrix-sync-cursor',
        stateClass: 'rebuildable-projection',
        schemaVersion: 1,
        migrationFromVersions: new Set<number>(),
    },
    {
        // Homeserver acknowledgements suppress identical root-signed control
        // writes after restart. Deleting this cache only causes safe replay.
        id: 'matrix-workspace-state-publication-cache',
        stateClass: 'rebuildable-projection',
        schemaVersion: 1,
        migrationFromVersions: new Set<number>(),
    },
    {
        // This inbox may contain a command after the Matrix cursor advanced
        // but before authorization claimed it. It is therefore durable-command
        // state, not a rebuildable transport cache.
        id: 'matrix-gateway-inbox',
        stateClass: 'durable-command',
        schemaVersion: 1,
        migrationFromVersions: new Set<number>(),
    },
    {
        // Activation intent and the previous symlink target must survive a
        // supervisor crash so restart recovery can finish or roll back.
        id: 'gateway-update-supervisor-state',
        stateClass: 'durable-command',
        schemaVersion: 1,
        migrationFromVersions: new Set<number>(),
    },
    {
        // This is the offline trust anchor for every remotely staged release.
        // Changing it is an explicit local key-rotation procedure, never an
        // ordinary online update migration.
        id: 'gateway-release-signer-pin',
        stateClass: 'security-critical',
        schemaVersion: 1,
        migrationFromVersions: new Set<number>(),
    },
    {
        id: 'native-client-release-state',
        stateClass: 'durable-command',
        schemaVersion: 1,
        migrationFromVersions: new Set<number>(),
    },
])
