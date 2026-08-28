import type { CommandPayload } from "@malink/protocol";

type PromptCommandPayload = Extract<
  CommandPayload,
  { operation: "prompt" }
>;

type CancelCommandPayload = Extract<
  CommandPayload,
  { operation: "cancel" }
>;

type ArtifactMaterializeCommandPayload = Extract<
  CommandPayload,
  { operation: "artifact.materialize" }
>;

export function createPromptCommandPayload(
  input: Omit<PromptCommandPayload, "operation">,
): PromptCommandPayload {
  const { attachments, ...prompt } = input;
  return {
    operation: "prompt",
    ...prompt,
    ...(attachments === undefined ? {} : { attachments }),
  };
}

export function createCancelCommandPayload(
  sessionId: string,
  targetCommandId: string,
): CancelCommandPayload {
  return {
    operation: "cancel",
    sessionId,
    targetCommandId,
  };
}

export function createArtifactMaterializeCommandPayload(
  sessionId: string,
  referenceId: string,
  expectedStatRevision: string,
): ArtifactMaterializeCommandPayload {
  return {
    operation: "artifact.materialize",
    sessionId,
    referenceId,
    expectedStatRevision,
  };
}
