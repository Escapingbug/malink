import { attachmentSchema, type MalinkAttachment } from "@malink/protocol";

/** Read only validated encrypted attachment descriptors from message semantics. */
export function messageAttachments(explicit: MalinkAttachment[] | undefined, semantic: unknown): MalinkAttachment[] | undefined {
  if (explicit?.length) return explicit;
  if (!semantic || typeof semantic !== "object" || Array.isArray(semantic)) return undefined;
  const value = semantic as Record<string, unknown>;
  const initial = value.initialPrompt;
  const source = value.type === "session.ready" && initial && typeof initial === "object" && !Array.isArray(initial)
    ? initial as Record<string, unknown> : value;
  if (!Array.isArray(source.attachments)) return undefined;
  const attachments = source.attachments.slice(0, 10).flatMap(item => {
    const parsed = attachmentSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
  return attachments.length ? attachments : undefined;
}
