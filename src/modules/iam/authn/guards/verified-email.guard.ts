import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  Optional,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRE_VERIFIED_EMAIL_KEY } from '../decorators/require-verified-email.decorator';

/**
 * Enterprise Guard that enforces active, verified email status on sensitive routes.
 * Blocks unverified users (status === 'pending_verification') from performing
 * actions that could trigger spam (invitations) or heavy resource consumption (AI Copilot).
 */
@Injectable()
export class VerifiedEmailGuard implements CanActivate {
  constructor(@Optional() private readonly reflector?: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector) {
      const requireVerified = this.reflector.getAllAndOverride<boolean>(
        REQUIRE_VERIFIED_EMAIL_KEY,
        [context.getHandler(), context.getClass()],
      );
      // If reflector is present and explicitly false, bypass check
      if (requireVerified === false) {
        return true;
      }
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    // Bypass for trusted inter-service calls
    if (user.isInternalService === true) {
      return true;
    }

    // Check verified status
    const isVerified =
      user.isVerified === true ||
      user.status === 'active';

    if (!isVerified) {
      throw new ForbiddenException({
        code: 'EMAIL_VERIFICATION_REQUIRED',
        message:
          'Please verify your email address to access this feature. Check your inbox for the verification link.',
      });
    }

    return true;
  }
}
