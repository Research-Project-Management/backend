import { SetMetadata, CustomDecorator } from '@nestjs/common';

export const REQUIRE_VERIFIED_EMAIL_KEY = 'requireVerifiedEmail';

/**
 * Decorator to mark routes as requiring an active, email-verified user account.
 * Rejects accounts with status === 'pending_verification'.
 */
export const RequireVerifiedEmail = (): CustomDecorator<string> =>
  SetMetadata(REQUIRE_VERIFIED_EMAIL_KEY, true);
