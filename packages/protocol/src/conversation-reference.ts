import { z } from 'zod'

/** Explicit user-selected context. Titles/text are presentation, never authority. */
export const conversationReferenceSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().min(1).max(256),
  title: z.string().min(1).max(512),
  kind: z.enum(['session', 'message']),
  messageId: z.string().min(1).max(512).optional(),
  text: z.string().max(12000).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'message' && (!value.messageId || !value.text)) {
    ctx.addIssue({ code: 'custom', message: 'An answer reference requires a message and text' })
  }
  if (value.kind === 'session' && (value.messageId !== undefined || value.text !== undefined)) {
    ctx.addIssue({ code: 'custom', message: 'Conversation references do not carry history in the prompt' })
  }
})
export const conversationReferencesSchema = z.array(conversationReferenceSchema).max(8)
  .refine(values => new Set(values.map(value => value.id)).size === values.length, 'Duplicate references')
export type MalinkConversationReference = z.infer<typeof conversationReferenceSchema>
