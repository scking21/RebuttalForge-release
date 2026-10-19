const HASH_PREFIX = "#/case/";

export function caseHref(id: string): string {
  return `${HASH_PREFIX}${encodeURIComponent(id)}`;
}

export function caseIdFromHash(hash: string): string | null {
  if (!hash.startsWith(HASH_PREFIX)) return null;
  try {
    return decodeURIComponent(hash.slice(HASH_PREFIX.length)) || null;
  } catch {
    return null;
  }
}

// React state updates do not synchronously disable a control. This lock closes
// the gap between repeated events in the same render, including keyboard submit.
export function createSingleFlight() {
  let busy = false;
  return async <T>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (busy) return undefined;
    busy = true;
    try {
      return await fn();
    } finally {
      busy = false;
    }
  };
}

export function sendAttemptKey(disputeId: string, revision: string | undefined): string {
  return JSON.stringify([disputeId, revision ?? null]);
}
