import type {
    ProviderControl,
    ProviderControlError,
    ProviderControlValue,
    ProviderControlValues,
} from '@malink/protocol'
import type { ModelEntry } from './provider'

export const MODEL_CONTROL_ID = 'model'
export const REASONING_CONTROL_ID = 'reasoningEffort'
export const PERMISSION_CONTROL_ID = 'permissionMode'

export const PROVIDER_CONTROL_SURFACES = [
    'project-default',
    'session-create',
    'session-active',
] as const

export interface ProviderCatalogState {
    status: 'loading' | 'ready' | 'stale' | 'error'
    error?: ProviderControlError
    checkedAt?: number
    deadlineAt?: number
    retryAt?: number
}

export function providerControls(
    models: readonly ModelEntry[],
    catalog: ProviderCatalogState,
    permissionModes: readonly string[],
): ProviderControl[] {
    return [
        ...modelControls(models, catalog),
        ...permissionControls(permissionModes),
    ]
}

export function modelControls(
    models: readonly ModelEntry[],
    catalog: ProviderCatalogState,
): ProviderControl[] {
    if (catalog.status === 'ready' && models.length === 0) return []

    const model: ProviderControl = {
        id: MODEL_CONTROL_ID,
        label: 'Model',
        description: 'Select the model used by this provider.',
        renderer: 'select',
        surfaces: [...PROVIDER_CONTROL_SURFACES],
        updateEffect: 'next-turn',
        status: catalog.status,
        options: models.map(entry => ({
            value: entry.id,
            label: entry.name,
            ...(entry.defaultReasoningLevel
                ? { defaults: { [REASONING_CONTROL_ID]: entry.defaultReasoningLevel } }
                : {}),
        })),
        ...(catalog.error ? { error: { ...catalog.error } } : {}),
        ...(catalog.checkedAt === undefined ? {} : { checkedAt: catalog.checkedAt }),
        ...(catalog.deadlineAt === undefined ? {} : { deadlineAt: catalog.deadlineAt }),
        ...(catalog.retryAt === undefined ? {} : { retryAt: catalog.retryAt }),
    }

    const modelsWithReasoning = models.filter(
        entry => (entry.supportedReasoningLevels?.length ?? 0) > 0,
    )
    if (modelsWithReasoning.length === 0) return [model]

    const efforts = new Map<string, {
        label: string
        description?: string
        models: string[]
    }>()
    for (const entry of modelsWithReasoning) {
        for (const level of entry.supportedReasoningLevels ?? []) {
            const existing = efforts.get(level.effort)
            if (existing) {
                existing.models.push(entry.id)
                if (!existing.description && level.description) existing.description = level.description
            } else {
                efforts.set(level.effort, {
                    label: level.effort,
                    ...(level.description ? { description: level.description } : {}),
                    models: [entry.id],
                })
            }
        }
    }
    const reasoning: ProviderControl = {
        id: REASONING_CONTROL_ID,
        label: 'Reasoning effort',
        description: 'Choose how much reasoning the selected model should use.',
        renderer: 'select',
        surfaces: [...PROVIDER_CONTROL_SURFACES],
        updateEffect: 'next-turn',
        status: catalog.status,
        options: [...efforts].map(([value, entry]) => ({
            value,
            label: entry.label,
            ...(entry.description ? { description: entry.description } : {}),
            when: { controlId: MODEL_CONTROL_ID, values: entry.models },
        })),
        ...(catalog.error ? { error: { ...catalog.error } } : {}),
        ...(catalog.checkedAt === undefined ? {} : { checkedAt: catalog.checkedAt }),
        ...(catalog.deadlineAt === undefined ? {} : { deadlineAt: catalog.deadlineAt }),
        ...(catalog.retryAt === undefined ? {} : { retryAt: catalog.retryAt }),
    }
    return [model, reasoning]
}

export function permissionControls(permissionModes: readonly string[]): ProviderControl[] {
    if (permissionModes.length <= 1) return []
    return [{
        id: PERMISSION_CONTROL_ID,
        label: 'Permission mode',
        description: 'Choose how the provider handles tool permissions.',
        renderer: 'select',
        surfaces: [...PROVIDER_CONTROL_SURFACES],
        updateEffect: 'next-turn',
        status: 'ready',
        options: permissionModes.map(value => ({
            value,
            label: permissionModeLabel(value),
        })),
        defaultValue: permissionModes.includes('default') ? 'default' : permissionModes[0],
    }]
}

export function providerControlError(error: unknown): ProviderControlError {
    const message = error instanceof Error ? error.message : String(error)
    const detail = message
        .replace(/\bauthorization\s*:\s*(?:bearer|basic)\s+\S+/giu, 'authorization: <redacted>')
        .replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*\S+/giu, '$1=<redacted>')
        .trim()
        .slice(0, 4_096)
    const normalized = message.toLowerCase()
    if (
        (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        || normalized.includes('enoent')
        || normalized.includes('not found')
    ) {
        return {
            code: 'executable_not_found',
            message: 'The Gateway could not find the provider executable. Check the service PATH or configure an absolute command path.',
            retryable: true,
            ...(detail ? { detail } : {}),
        }
    }
    if (normalized.includes('timed out') || normalized.includes('timeout')) {
        return {
            code: 'catalog_timeout',
            message: 'The provider did not return its available choices in time.',
            retryable: true,
            ...(detail ? { detail } : {}),
        }
    }
    if (
        normalized.includes('unauthorized')
        || normalized.includes('not logged in')
        || normalized.includes('authentication')
    ) {
        return {
            code: 'authentication_required',
            message: 'The provider needs to be signed in before its choices can be loaded.',
            retryable: true,
            ...(detail ? { detail } : {}),
        }
    }
    return {
        code: 'catalog_failed',
        message: 'The provider choices could not be loaded.',
        retryable: true,
        ...(detail ? { detail } : {}),
    }
}

export function legacyControlValues(input: {
    model?: string | null
    reasoningEffort?: string | null
    permissionMode?: string | null
    controls?: ProviderControlValues
}): ProviderControlValues {
    const values: ProviderControlValues = { ...(input.controls ?? {}) }
    for (const [key, id] of [
        ['model', MODEL_CONTROL_ID],
        ['reasoningEffort', REASONING_CONTROL_ID],
        ['permissionMode', PERMISSION_CONTROL_ID],
    ] as const) {
        if (!(key in input)) continue
        const value = input[key]
        if (value) values[id] = value
        else delete values[id]
    }
    return values
}

export function controlValue(
    values: ProviderControlValues,
    id: string,
): ProviderControlValue | undefined {
    return values[id]
}

function permissionModeLabel(value: string): string {
    switch (value) {
        case 'default': return 'Default'
        case 'acceptEdits':
        case 'accept_edits': return 'Accept edits'
        case 'bypassPermissions':
        case 'bypass_permissions': return 'Full access'
        case 'plan': return 'Plan'
        default: return value
    }
}
