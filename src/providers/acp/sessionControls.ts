import type { ProviderControl } from '@malink/protocol'
import type { SessionConfigOption, SessionModelState } from '@agentclientprotocol/sdk'
import { MODEL_CONTROL_ID, REASONING_CONTROL_ID } from '@/providers/controls'

const ACTIVE_SURFACE = ['session-active'] as const
const CONTROL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u

export function acpSessionControls(
    models: SessionModelState | null | undefined,
    configOptions: readonly SessionConfigOption[] = [],
): ProviderControl[] {
    const controls = new Map<string, ProviderControl>()

    if (models && models.availableModels.length > 0) {
        controls.set(MODEL_CONTROL_ID, {
            id: MODEL_CONTROL_ID,
            label: 'Model',
            description: 'Select the model used by this session.',
            renderer: 'select',
            surfaces: [...ACTIVE_SURFACE],
            updateEffect: 'next-turn',
            status: 'ready',
            value: models.currentModelId,
            options: models.availableModels.map(model => ({
                value: model.modelId,
                label: model.name,
                ...(model.description ? { description: model.description } : {}),
            })),
        })
    }

    for (const option of configOptions) {
        const id = controlId(option)
        if (!id) continue
        if (option.type === 'boolean') {
            controls.set(id, {
                id,
                label: option.name,
                ...(option.description ? { description: option.description } : {}),
                renderer: 'toggle',
                surfaces: [...ACTIVE_SURFACE],
                updateEffect: 'next-turn',
                status: 'ready',
                value: option.currentValue,
            })
            continue
        }

        const values = option.options.flatMap(candidate => (
            'value' in candidate ? [candidate] : candidate.options
        ))
        if (values.length === 0) continue
        controls.set(id, {
            id,
            label: option.name,
            ...(option.description ? { description: option.description } : {}),
            renderer: values.length <= 4 ? 'segmented' : 'select',
            surfaces: [...ACTIVE_SURFACE],
            updateEffect: 'next-turn',
            status: 'ready',
            value: option.currentValue,
            options: values.map(value => ({
                value: value.value,
                label: value.name,
                ...(value.description ? { description: value.description } : {}),
            })),
        })
    }

    return [...controls.values()]
}

function controlId(option: SessionConfigOption): string | null {
    if (typeof option.id !== 'string') return null
    if (option.category === 'model' || option.id === 'model') return MODEL_CONTROL_ID
    if (
        option.category === 'thought_level'
        || option.id === 'reasoning_effort'
        || option.id === 'reasoningEffort'
    ) {
        return REASONING_CONTROL_ID
    }
    const id = option.id.trim()
    return CONTROL_ID.test(id) ? id : null
}
