export type MatrixThreadReceipt = {
  eventId: string;
  threadRootEventId: string;
  timestamp: number;
};

/** Extracts only this account's private threaded receipts from m.receipt content. */
export function parseOwnPrivateThreadReceipts(
  input: unknown,
  userId: string,
): MatrixThreadReceipt[] {
  if (!isRecord(input) || !userId) return [];
  const receipts: MatrixThreadReceipt[] = [];
  for (const [eventId, groupsValue] of Object.entries(input)) {
    if (!eventId || !isRecord(groupsValue)) continue;
    const users = groupsValue["m.read.private"];
    if (!isRecord(users)) continue;
    const receipt = users[userId];
    if (!isRecord(receipt)) continue;
    const threadRootEventId = receipt.thread_id;
    const timestamp = receipt.ts;
    if (
      typeof threadRootEventId !== "string"
      || !threadRootEventId
      || threadRootEventId === "main"
      || typeof timestamp !== "number"
      || !Number.isSafeInteger(timestamp)
      || timestamp < 0
    ) continue;
    receipts.push({ eventId, threadRootEventId, timestamp });
  }
  return receipts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
