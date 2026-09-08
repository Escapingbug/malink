type Values = Record<string, string | boolean | number>;

export function sessionSettingsProjected(
  update: { changes: Values; cleared: readonly string[] },
  session: { controlValues?: Values; model?: string; reasoningEffort?: string },
): boolean {
  const values: Values = {
    ...session.controlValues,
    ...(session.model ? { model: session.model } : {}),
    ...(session.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
  };
  return Object.entries(update.changes).every(([key, value]) => values[key] === value)
    && update.cleared.every(key => values[key] == null);
}
