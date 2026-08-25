import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { User } from '@prisma/client';

import { AuthnRepository } from './authn.repository';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import {
  AuthnResponseDto,
  TokenRefreshResponseDto,
  UserSummaryResponseDto,
} from './dto/authn-response.dto';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface OAuthUserProfile {
  id: string;
  email?: string;
  name?: string;
  avatar?: string;
  provider: 'google' | 'github';
}

/**
 * Enterprise Authentication & Identity Service.
 * Manages user credentials, JWT lifecycle, Redis-backed OAuth state validation,
 * cryptographic token hashing, and breach reuse detection.
 */
@Injectable()
export class AuthnService {
  private readonly logger = new Logger(AuthnService.name);

  // Redis Key Prefixes (following redis-core colon standard)
  private static readonly OAUTH_STATE_PREFIX = 'flux:iam:oauth_state';
  private static readonly OAUTH_TICKET_PREFIX = 'flux:iam:oauth_ticket';

  constructor(
    private readonly authnRepo: AuthnRepository,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redis: RedisCacheService,
  ) {}

  /**
   * Cryptographically hashes a refresh token before persistence.
   */
  private hashToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  /**
   * Formats a Prisma User model into a sanitized UserSummaryResponseDto.
   */
  formatUser(user: User): UserSummaryResponseDto;
  formatUser(user: null | undefined): null;
  formatUser(user: User | null | undefined): UserSummaryResponseDto | null;
  formatUser(user: User | null | undefined): UserSummaryResponseDto | null {
    if (!user) return null;
    const { password, ...rest } = user;
    return rest as UserSummaryResponseDto;
  }

  /**
   * Generates a signed Access Token & Refresh Token pair.
   */
  private async generateTokens(user: {
    id: string;
    email: string | null;
    name: string;
  }): Promise<TokenPair> {
    const payload = {
      sub: user.id,
      id: user.id,
      email: user.email,
      name: user.name,
    };

    const accessTokenSecret = this.configService.get<string>('JWT_SECRET');
    const refreshTokenSecret =
      this.configService.get<string>('JWT_REFRESH_SECRET');

    if (!accessTokenSecret || !refreshTokenSecret) {
      throw new UnauthorizedException(
        'JWT secrets are not configured in environment',
      );
    }

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: accessTokenSecret,
        expiresIn: (this.configService.get<string>('JWT_EXPIRES_IN') ||
          '1h') as any,
      }),
      this.jwtService.signAsync(payload, {
        secret: refreshTokenSecret,
        expiresIn: (this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') ||
          '30d') as any,
      }),
    ]);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    await this.authnRepo.createRefreshToken({
      userId: user.id,
      token: this.hashToken(refreshToken),
      expiresAt,
    });

    return { accessToken, refreshToken };
  }

  // ─── OAuth Redis State Management ──────────────────────────────────────────

  async createOAuthState(): Promise<string> {
    const state = crypto.randomBytes(24).toString('hex');
    const key = `${AuthnService.OAUTH_STATE_PREFIX}:${state}`;
    await this.redis.set(key, { createdAt: Date.now() }, 300); // 5 minutes TTL
    return state;
  }

  async verifyOAuthState(state?: string): Promise<boolean> {
    if (!state) return false;
    const key = `${AuthnService.OAUTH_STATE_PREFIX}:${state}`;
    const record = await this.redis.get<{ createdAt: number }>(key);
    if (!record) return false;
    await this.redis.del(key);
    return true;
  }

  async createOAuthExchangeTicket(data: AuthnResponseDto): Promise<string> {
    const ticket = crypto.randomBytes(32).toString('hex');
    const key = `${AuthnService.OAUTH_TICKET_PREFIX}:${ticket}`;
    await this.redis.set(key, data, 60); // 60 seconds TTL
    return ticket;
  }

  async exchangeOAuthTicket(ticket: string): Promise<AuthnResponseDto> {
    if (!ticket) {
      throw new UnauthorizedException('OAuth exchange ticket is required');
    }
    const key = `${AuthnService.OAUTH_TICKET_PREFIX}:${ticket}`;
    const data = await this.redis.get<AuthnResponseDto>(key);
    if (!data) {
      throw new UnauthorizedException(
        'OAuth exchange ticket is invalid or expired',
      );
    }
    await this.redis.del(key);
    return data;
  }

  // ─── OAuth Provider Logic ──────────────────────────────────────────────────

  async getGoogleAuthUrl(): Promise<string> {
    const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
    const apiUrl =
      this.configService.get<string>('API_URL') || 'http://localhost:3000';
    const redirectUri = `${apiUrl}/auth/google/callback`;
    const state = await this.createOAuthState();

    return (
      'https://accounts.google.com/o/oauth2/v2/auth?client_id=' +
      clientId +
      '&redirect_uri=' +
      encodeURIComponent(redirectUri) +
      '&response_type=code&scope=' +
      encodeURIComponent('openid email profile') +
      '&state=' +
      encodeURIComponent(state) +
      '&access_type=offline&prompt=consent'
    );
  }

  async handleGoogleCallback(
    code?: string,
    state?: string,
    error?: string,
  ): Promise<{ redirectUrl: string }> {
    const clientUrl =
      this.configService.get<string>('CLIENT_URL') || 'http://localhost:2915';

    if (error || !code) {
      return {
        redirectUrl: `${clientUrl}/login?error=${error || 'no_code'}`,
      };
    }

    const isValidState = await this.verifyOAuthState(state);
    if (!isValidState) {
      return {
        redirectUrl: `${clientUrl}/login?error=invalid_csrf_state`,
      };
    }

    try {
      const clientId = this.configService.get<string>('GOOGLE_CLIENT_ID');
      const clientSecret = this.configService.get<string>(
        'GOOGLE_CLIENT_SECRET',
      );
      const apiUrl =
        this.configService.get<string>('API_URL') || 'http://localhost:3000';
      const redirectUri = `${apiUrl}/auth/google/callback`;

      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: clientId || '',
          client_secret: clientSecret || '',
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
      });

      const tokenData = (await tokenRes.json()) as { access_token?: string };
      if (!tokenData.access_token) {
        return {
          redirectUrl: `${clientUrl}/login?error=google_token_failed`,
        };
      }

      const userRes = await fetch(
        'https://www.googleapis.com/oauth2/v2/userinfo',
        {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        },
      );
      const googleUser = (await userRes.json()) as {
        id: string;
        email?: string;
        name?: string;
        picture?: string;
      };

      const result = await this.handleOAuth({
        id: googleUser.id,
        email: googleUser.email,
        name: googleUser.name,
        avatar: googleUser.picture,
        provider: 'google',
      });

      const ticket = await this.createOAuthExchangeTicket(result);
      return {
        redirectUrl: `${clientUrl}/auth/callback?code=${ticket}`,
      };
    } catch (err) {
      this.logger.error(
        `Google OAuth failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { redirectUrl: `${clientUrl}/login?error=oauth_error` };
    }
  }

  async getGithubAuthUrl(): Promise<string> {
    const clientId = this.configService.get<string>('GITHUB_CLIENT_ID');
    const apiUrl =
      this.configService.get<string>('API_URL') || 'http://localhost:3000';
    const redirectUri = `${apiUrl}/auth/github/callback`;
    const state = await this.createOAuthState();

    return (
      'https://github.com/login/oauth/authorize?client_id=' +
      clientId +
      '&redirect_uri=' +
      encodeURIComponent(redirectUri) +
      '&state=' +
      encodeURIComponent(state) +
      '&scope=' +
      encodeURIComponent('read:user user:email')
    );
  }

  async handleGithubCallback(
    code?: string,
    state?: string,
    error?: string,
  ): Promise<{ redirectUrl: string }> {
    const clientUrl =
      this.configService.get<string>('CLIENT_URL') || 'http://localhost:2915';

    if (error || !code) {
      return {
        redirectUrl: `${clientUrl}/login?error=${error || 'no_code'}`,
      };
    }

    const isValidState = await this.verifyOAuthState(state);
    if (!isValidState) {
      return {
        redirectUrl: `${clientUrl}/login?error=invalid_csrf_state`,
      };
    }

    try {
      const clientId = this.configService.get<string>('GITHUB_CLIENT_ID');
      const clientSecret = this.configService.get<string>(
        'GITHUB_CLIENT_SECRET',
      );

      const tokenRes = await fetch(
        'https://github.com/login/oauth/access_token',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
          }),
        },
      );

      const tokenData = (await tokenRes.json()) as { access_token?: string };
      if (!tokenData.access_token) {
        return {
          redirectUrl: `${clientUrl}/login?error=github_token_failed`,
        };
      }

      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          'User-Agent': 'RPM-App',
        },
      });
      const githubUser = (await userRes.json()) as {
        id: number;
        email?: string;
        name?: string;
        login?: string;
        avatar_url?: string;
      };

      let email = githubUser.email;
      if (!email) {
        const emailsRes = await fetch('https://api.github.com/user/emails', {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            'User-Agent': 'RPM-App',
          },
        });
        const emails = (await emailsRes.json()) as Array<{
          email: string;
          primary: boolean;
        }>;
        if (Array.isArray(emails)) {
          const primary = emails.find((ei) => ei.primary);
          email = primary?.email || emails[0]?.email;
        }
      }

      const result = await this.handleOAuth({
        id: String(githubUser.id),
        email,
        name: githubUser.name || githubUser.login,
        avatar: githubUser.avatar_url,
        provider: 'github',
      });

      const ticket = await this.createOAuthExchangeTicket(result);
      return {
        redirectUrl: `${clientUrl}/auth/callback?code=${ticket}`,
      };
    } catch (err) {
      this.logger.error(
        `GitHub OAuth failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { redirectUrl: `${clientUrl}/login?error=oauth_error` };
    }
  }

  async handleOAuth(profile: OAuthUserProfile): Promise<AuthnResponseDto> {
    const providerField: 'googleId' | 'githubId' =
      profile.provider === 'google' ? 'googleId' : 'githubId';

    let user = await this.authnRepo.findUserByOAuth(
      providerField,
      profile.id,
      profile.email,
    );

    if (!user) {
      user = await this.authnRepo.createUser({
        email: profile.email?.toLowerCase() || null,
        name: profile.name || 'User',
        avatar: profile.avatar || null,
        [providerField]: profile.id,
        isVerified: true,
      });
    } else if (!user[providerField]) {
      user = await this.authnRepo.updateUser(user.id, {
        [providerField]: profile.id,
      });
    }

    const tokens = await this.generateTokens(user);
    return {
      user: this.formatUser(user),
      ...tokens,
    };
  }

  // ─── Standard Credentials Authentication ───────────────────────────────────

  async registerUser(dto: RegisterDto): Promise<AuthnResponseDto> {
    const existing = await this.authnRepo.findUserByEmail(dto.email);

    if (existing) {
      throw new BadRequestException('Email is already registered');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const user = await this.authnRepo.createUser({
      email: dto.email.toLowerCase(),
      password: hashedPassword,
      name: dto.name || 'User',
      avatar: dto.avatar || null,
      isVerified: true,
    });

    const tokens = await this.generateTokens(user);
    return {
      user: this.formatUser(user),
      ...tokens,
    };
  }

  async login(dto: LoginDto): Promise<AuthnResponseDto> {
    const user = await this.authnRepo.findUserByEmail(dto.email);

    if (!user || !user.password) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isMatch = await bcrypt.compare(dto.password, user.password);
    if (!isMatch) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const tokens = await this.generateTokens(user);
    return {
      user: this.formatUser(user),
      ...tokens,
    };
  }

  async refresh(refreshToken: string): Promise<TokenRefreshResponseDto> {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }

    const tokenHash = this.hashToken(refreshToken);
    const tokenRecord = await this.authnRepo.findRefreshToken(tokenHash);

    if (tokenRecord && tokenRecord.revokedAt) {
      await this.authnRepo.revokeAllUserTokens(tokenRecord.userId);
      throw new UnauthorizedException(
        'Compromised session detected. All sessions terminated. Please log in again.',
      );
    }

    if (!tokenRecord || tokenRecord.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token is invalid or expired');
    }

    await this.authnRepo.revokeRefreshToken(tokenHash);
    const newTokens = await this.generateTokens(tokenRecord.user);

    return {
      accessToken: newTokens.accessToken,
      refreshToken: newTokens.refreshToken,
      user: this.formatUser(tokenRecord.user),
    };
  }

  async logout(refreshToken?: string): Promise<{ message: string }> {
    if (refreshToken) {
      const tokenHash = this.hashToken(refreshToken);
      await this.authnRepo.revokeRefreshToken(tokenHash);
    }
    return { message: 'Logged out successfully' };
  }

  // ─── Password Reset Flow ──────────────────────────────────────────────────

  private static readonly RESET_TOKEN_PREFIX = 'flux:iam:pwd_reset';
  private static readonly RESET_TOKEN_TTL_S = 60 * 60; // 1 hour

  /**
   * Generate a cryptographically secure reset token, store its hash in Redis,
   * and return the raw token so the caller can include it in an email link.
   * The actual email dispatch is the responsibility of a Notification/Mailer
   * service (not yet wired) — the token is logged at DEBUG level for dev testing.
   */
  async forgotPassword(email: string): Promise<{ message: string; _devToken?: string }> {
    // Always return the same generic message to prevent user enumeration.
    const genericResponse = {
      message: 'If this email is registered, a reset link will be sent.',
    };

    const user = await this.authnRepo.findUserByEmail(email);
    if (!user || !user.email) return genericResponse;

    // Generate a 32-byte random token (URL-safe base64)
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = this.hashToken(rawToken);

    const redisKey = `${AuthnService.RESET_TOKEN_PREFIX}:${tokenHash}`;
    await this.redis.set(redisKey, { userId: user.id, email: user.email }, AuthnService.RESET_TOKEN_TTL_S);

    this.logger.debug(`[dev] Password reset token for ${email}: ${rawToken}`);

    // TODO: dispatch email via MailerService when available
    // await this.mailerService.sendPasswordReset(user.email, rawToken);

    return {
      ...genericResponse,
      // Only exposed in non-production for testing — strip in prod via response interceptor or remove when mailer is wired
      ...(process.env.NODE_ENV !== 'production' && { _devToken: rawToken }),
    };
  }

  /**
   * Validate the reset token from Redis, hash the new password, update the user,
   * and revoke the token so it cannot be reused.
   */
  async resetPassword(token: string, newPassword: string): Promise<{ message: string }> {
    if (!token || !newPassword) {
      throw new BadRequestException('Token and new password are required');
    }
    if (newPassword.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
    }

    const tokenHash = this.hashToken(token);
    const redisKey = `${AuthnService.RESET_TOKEN_PREFIX}:${tokenHash}`;
    const stored = await this.redis.get<{ userId: string; email: string }>(redisKey);

    if (!stored) {
      throw new BadRequestException('Reset token is invalid or has expired');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await this.authnRepo.updateUserPassword(stored.userId, hashedPassword);

    // Revoke the token immediately — single-use only
    await this.redis.del(redisKey);

    // Revoke all active refresh tokens for extra security
    await this.authnRepo.revokeAllUserRefreshTokens(stored.userId);

    this.logger.log(`Password reset completed for user ${stored.userId}`);
    return { message: 'Password has been reset successfully.' };
  }
}

// Backward compatibility aliases
export const AuthService = AuthnService;
export type AuthService = AuthnService;
export const AuthenticationService = AuthnService;
export type AuthenticationService = AuthnService;
