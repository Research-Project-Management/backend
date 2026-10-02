/**
 * Resolves and normalizes the effective Project ID from URL parameter or query string.
 * Strips pseudo-project placeholders ('me', 'user', 'personal').
 */
export const toValidProjectId = (val?: string): string | undefined => {
  if (!val || val === 'me' || val === 'user' || val === 'personal') {
    return undefined;
  }
  return val;
};
