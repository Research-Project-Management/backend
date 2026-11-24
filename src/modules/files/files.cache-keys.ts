export const FILES_CACHE_KEYS = {
  presignCompleteIdempotency: (keyDigest: string) =>
    `files:idem:complete:${keyDigest}`,
} as const;
