import type { CommandPayload } from "@malink/protocol";
import { CommandReviewRequiredError } from "./client/MalinkClient";
import { CommandRevisionConflictError } from "./matrix";

const DEFAULT_AUTOMATIC_REVISION_RETRIES = 3;

type RevisionConflict = {
  commandId: string;
  operation: CommandPayload["operation"] | undefined;
};

function revisionConflictFromError(error: unknown): RevisionConflict | null {
  if (error instanceof CommandReviewRequiredError) {
    return {
      commandId: error.review.commandId,
      operation: error.review.operation,
    };
  }
  if (error instanceof CommandRevisionConflictError) {
    return {
      commandId: error.commandId,
      operation: error.payload.operation,
    };
  }
  return null;
}

/**
 * Rebase an operation which is safe to repeat after another client advances the
 * shared Gateway revision. Native conflict notifications created for the
 * command currently awaiting acknowledgement may omit the operation, while a
 * blocker for an older command always carries it. Refuse to replay the latter
 * when it belongs to a different action.
 */
export async function retryMatchingCommandRevisionConflict<T>(
  initialError: unknown,
  operation: CommandPayload["operation"],
  retry: (commandId: string) => Promise<T>,
  maxRetries = DEFAULT_AUTOMATIC_REVISION_RETRIES,
): Promise<T> {
  if (!Number.isSafeInteger(maxRetries) || maxRetries <= 0) {
    throw new RangeError("Automatic revision retries must be a positive integer.");
  }
  let currentError = initialError;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const conflict = revisionConflictFromError(currentError);
    if (
      !conflict ||
      (conflict.operation !== undefined && conflict.operation !== operation)
    ) {
      throw currentError;
    }
    try {
      return await retry(conflict.commandId);
    } catch (error) {
      currentError = error;
    }
  }
  throw currentError;
}
