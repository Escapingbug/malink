/** Only newer authenticated evidence may supersede a failed read-only check. */
export function gatewayCheckFailureStillCurrent(input: {
  failed: boolean; checkedAt?: number; lastVerifiedAt?: number;
}): boolean {
  return input.failed && (input.checkedAt === undefined || input.lastVerifiedAt === undefined ||
    input.lastVerifiedAt <= input.checkedAt);
}
