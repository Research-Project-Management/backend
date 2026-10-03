/**
 * @deprecated Technical debt removed. Project scopes are now strictly validated
 * via ParseUUIDPipe and separated into dedicated Project controllers.
 * Kept strictly as a backwards-compatibility stub for legacy callers.
 */
export const toValidProjectId = (val?: string): string | undefined => {
  if (!val || val === 'me' || val === 'user' || val === 'personal') {
    return undefined;
  }
  return val;
};
