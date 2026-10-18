import { SetMetadata } from '@nestjs/common';

export const REQUIRE_OPERATOR_KEY = 'require_operator';

/**
 * Marks an endpoint as requiring platform operator privileges.
 * Enforced by OperatorGuard or ProjectAccessGuard using AccessConfigService.operatorUserIds allowlist.
 */
export const RequireOperator = () => SetMetadata(REQUIRE_OPERATOR_KEY, true);
