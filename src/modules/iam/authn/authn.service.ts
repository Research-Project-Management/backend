import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { User, AuthProvider } from '@prisma/client';

import { AuthnRepository } from './authn.repository';
import { FederatedIdentityRepository } from '../user/federated-identity.repository';
import { AuditService } from '../audit/audit.service';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import {
  AuthnResponseDto,
  TokenRefreshResponseDto,
  UserSummaryResponseDto,
} from './dto/authn-response.dto';
import { IAM_REDIS_KEYS } from '../constants/redis-keys.constant';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface SessionSummary {
  id: string;
  userId: string;
  familyId: string | null;
  parentId: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  deviceType: string | null;
  lastUsedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
  isRevoked: boolean;
}

export interface OAuthUserProfile {
  id: string;
  email?: string;
  name?: string;
  avatar?: string;
  provider: 'google' | 'github' | 'orcid';
}

/**
 * Enterprise Authentication & Identity Service.
 * Manages user credentials, JWT lifecycle, Redis-backed OAuth state validation,
 * cryptographic token hashing, token family rotation, and breach reuse detection.
 */
@Injectable()
export class AuthnService {
  private readonly logger = new Logger(AuthnService.name);

  constructor(
    private readonly authnRepo: AuthnRepository,
    private readonly federatedRepo: FederatedIdentityRepository,
    private readonly auditService: AuditService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redis: RedisCacheService,
  ) {}

  /**
   * Cryptographically hashes a refresh token before persistence (SHA-256).
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
    return rest;
  }

  private getRefreshTokenExpiresAt(): Date {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    return expiresAt;
  }

  private async signTokenPair(user: {
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
      this.configService.get<string>('JWT_REFRESH_SECRET') || accessTokenSecret;

    if (!accessTokenSecret) {
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

    return { accessToken, refreshToken };
  }

  /**
   * Generates a signed Access Token & Refresh Token pair with token family lineage.
   */
  private async generateTokens(
    user: { id: string; email: string | null; name: string },
    options?: {
      familyId?: string;
      parentId?: string;
      userAgent?: string;
      ipAddress?: string;
    },
  ): Promise<TokenPair> {
    const { accessToken, refreshToken } = await this.signTokenPair(user);
    const expiresAt = this.getRefreshTokenExpiresAt();
    const tokenHash = this.hashToken(refreshToken);
    const familyId = options?.familyId || crypto.randomUUID();

    const session = await this.authnRepo.createSession({
      userId: user.id,
      tokenHash,
      familyId,
      parentId: options?.parentId,
      expiresAt,
      userAgent: options?.userAgent,
      ipAddress: options?.ipAddress,
    });

    // Cache active session in Redis
    const sessionCacheKey = IAM_REDIS_KEYS.session(session.id);
    await this.redis.set(
      sessionCacheKey,
      {
        userId: user.id,
        familyId,
        isValid: true,
        expiresAt: expiresAt.toISOString(),
        ipAddress: options?.ipAddress,
        userAgent: options?.userAgent,
      },
      30 * 24 * 3600, // 30 days
    );

    return { accessToken, refreshToken };
  }

  // ─── OAuth Redis State Management ──────────────────────────────────────────

  async createOAuthState(): Promise<string> {
    const state = crypto.randomBytes(24).toString('hex');
    const key = IAM_REDIS_KEYS.oauthState(state);
    await this.redis.set(key, { createdAt: Date.now() }, 300); // 5 minutes TTL
    return state;
  }

  async verifyOAuthState(state?: string): Promise<boolean> {
    if (!state) return false;
    const key = IAM_REDIS_KEYS.oauthState(state);
    const record = await this.redis.get<{ createdAt: number }>(key);
    if (!record) return false;
    await this.redis.del(key);
    return true;
  }

  async createOAuthExchangeTicket(data: AuthnResponseDto): Promise<string> {
    const ticket = crypto.randomBytes(32).toString('hex');
    const key = `flux:iam:oauth_ticket:${ticket}`;
    await this.redis.set(key, data, 60); // 60 seconds TTL
    return ticket;
  }

  async exchangeOAuthTicket(ticket: string): Promise<AuthnResponseDto> {
    if (!ticket) {
      throw new UnauthorizedException('OAuth exchange ticket is required');
    }
    const key = `flux:iam:oauth_ticket:${ticket}`;
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
      '&scope=' +
      encodeURIComponent('user:email read:user') +
      '&state=' +
      encodeURIComponent(state)
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
      const apiUrl =
        this.configService.get<string>('API_URL') || 'http://localhost:3000';
      const redirectUri = `${apiUrl}/auth/github/callback`;

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
            redirect_uri: redirectUri,
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
          'User-Agent': 'Flux-App',
        },
      });
      const githubUser = (await userRes.json()) as {
        id: number;
        login: string;
        name?: string;
        email?: string;
        avatar_url?: string;
      };

      let email = githubUser.email;
      if (!email) {
        const emailsRes = await fetch('https://api.github.com/user/emails', {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            'User-Agent': 'Flux-App',
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
    const providerEnum = profile.provider as AuthProvider;

    // 1. Check if federated identity exists
    const federatedRecord = await this.federatedRepo.findByProviderSubject(
      providerEnum,
      profile.id,
    );

    let user: User;

    if (federatedRecord) {
      user = federatedRecord.user;
    } else {
      // 2. Check if user with matching email already exists
      const existingUser = profile.email
        ? await this.authnRepo.findUserByEmail(profile.email)
        : null;

      if (existingUser) {
        user = existingUser;
      } else {
        // Create new user profile
        user = await this.authnRepo.createUser({
          email: profile.email?.toLowerCase() || null,
          name: profile.name || 'User',
          avatar: profile.avatar || null,
          isVerified: true,
          status: 'active',
        });
      }

      // Link federated identity
      await this.federatedRepo.linkIdentity({
        userId: user.id,
        provider: providerEnum,
        providerSubjectId: profile.id,
        email: profile.email?.toLowerCase(),
        profileData: { name: profile.name, avatar: profile.avatar },
      });

      await this.auditService.log({
        actorId: user.id,
        eventType: 'oauth_account_linked',
        targetType: 'user',
        targetId: user.id,
        metadata: { provider: profile.provider },
      });
    }

    const tokens = await this.generateTokens(user);

    await this.auditService.log({
      actorId: user.id,
      eventType: 'login_success',
      targetType: 'user',
      targetId: user.id,
      metadata: { method: `oauth_${profile.provider}` },
    });

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
      status: 'active',
    });

    const tokens = await this.generateTokens(user);

    await this.auditService.log({
      actorId: user.id,
      eventType: 'login_success',
      targetType: 'user',
      targetId: user.id,
      metadata: { method: 'local_registration' },
    });

    return {
      user: this.formatUser(user),
      ...tokens,
    };
  }

  async login(dto: LoginDto): Promise<AuthnResponseDto> {
    const user = await this.authnRepo.findUserByEmail(dto.email);

    if (!user || !user.password) {
      await this.auditService.log({
        eventType: 'login_failed',
        targetType: 'user',
        metadata: { email: dto.email, reason: 'user_not_found_or_no_password' },
      });
      throw new UnauthorizedException('Invalid email or password');
    }

    const isMatch = await bcrypt.compare(dto.password, user.password);
    if (!isMatch) {
      await this.auditService.log({
        actorId: user.id,
        eventType: 'login_failed',
        targetType: 'user',
        targetId: user.id,
        metadata: { email: dto.email, reason: 'password_mismatch' },
      });
      throw new UnauthorizedException('Invalid email or password');
    }

    const tokens = await this.generateTokens(user);

    await this.auditService.log({
      actorId: user.id,
      eventType: 'login_success',
      targetType: 'user',
      targetId: user.id,
      metadata: { method: 'password' },
    });

    return {
      user: this.formatUser(user),
      ...tokens,
    };
  }

  // ─── Token Rotation with Family Breach Detection ───────────────────────────

  async refresh(refreshToken: string): Promise<TokenRefreshResponseDto> {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }

    const tokenHash = this.hashToken(refreshToken);
    const tokenRecord = await this.authnRepo.findRefreshToken(tokenHash);

    // BREACH DETECTION: If token was already revoked, check grace period first before triggering full breach
    if (tokenRecord && (tokenRecord.isRevoked || tokenRecord.revokedAt)) {
      const GRACE_PERIOD_MS = 15_000;
      const revokedTime = tokenRecord.revokedAt
        ? new Date(tokenRecord.revokedAt).getTime()
        : 0;
      const isWithinGrace =
        revokedTime > 0 && Date.now() - revokedTime < GRACE_PERIOD_MS;

      if (isWithinGrace) {
        this.logger.warn(
          `Token refresh race condition detected within grace window (familyId: ${tokenRecord.familyId}). Request safely rejected without revoking session family.`,
        );
        throw new UnauthorizedException(
          'Session is currently refreshing. Please retry.',
        );
      }

      if (tokenRecord.familyId) {
        await this.authnRepo.revokeFamily(tokenRecord.familyId);
      } else {
        await this.authnRepo.revokeAllUserTokens(tokenRecord.userId);
      }

      await this.auditService.log({
        actorId: tokenRecord.userId,
        eventType: 'token_breach_detected',
        targetType: 'session',
        targetId: tokenRecord.id,
        metadata: {
          familyId: tokenRecord.familyId,
          reason: 'revoked_token_replay',
        },
      });

      throw new UnauthorizedException(
        'Compromised session detected. All sessions in this token family have been terminated. Please log in again.',
      );
    }

    if (!tokenRecord || tokenRecord.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token is invalid or expired');
    }

    const familyId = tokenRecord.familyId || crypto.randomUUID();
    const newTokens = await this.signTokenPair(tokenRecord.user);
    const newTokenHash = this.hashToken(newTokens.refreshToken);

    try {
      await this.authnRepo.rotateToken({
        oldTokenId: tokenRecord.id,
        newTokenHash,
        familyId,
        userId: tokenRecord.userId,
        expiresAt: this.getRefreshTokenExpiresAt(),
      });
    } catch {
      throw new UnauthorizedException('Refresh token is invalid or expired');
    }

    await this.auditService.log({
      actorId: tokenRecord.userId,
      eventType: 'token_refreshed',
      targetType: 'session',
      targetId: tokenRecord.id,
      metadata: { familyId },
    });

    return {
      accessToken: newTokens.accessToken,
      refreshToken: newTokens.refreshToken,
      user: this.formatUser(tokenRecord.user),
    };
  }

  async logout(refreshToken?: string): Promise<{ message: string }> {
    if (refreshToken) {
      const tokenHash = this.hashToken(refreshToken);
      const tokenRecord = await this.authnRepo.findRefreshToken(tokenHash);
      if (tokenRecord) {
        await this.authnRepo.revokeRefreshToken(tokenHash);
        await this.redis.del(IAM_REDIS_KEYS.session(tokenRecord.id));

        await this.auditService.log({
          actorId: tokenRecord.userId,
          eventType: 'logout',
          targetType: 'session',
          targetId: tokenRecord.id,
        });
      }
    }
    return { message: 'Logged out successfully' };
  }

  // ─── Password Reset Lifecycle ──────────────────────────────────────────────

  async forgotPassword(email: string): Promise<{ message: string }> {
    const user = await this.authnRepo.findUserByEmail(email);
    if (!user) {
      return {
        message:
          'If that email is registered, a password reset link has been sent.',
      };
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetKey = `flux:iam:pw_reset:${resetToken}`;
    await this.redis.set(resetKey, { userId: user.id }, 900); // 15 min TTL

    await this.auditService.log({
      actorId: user.id,
      eventType: 'password_reset_requested',
      targetType: 'user',
      targetId: user.id,
    });

    return {
      message:
        'If that email is registered, a password reset link has been sent.',
    };
  }

  async resetPassword(
    token: string,
    newPass: string,
  ): Promise<{ message: string }> {
    const resetKey = `flux:iam:pw_reset:${token}`;
    const record = await this.redis.get<{ userId: string }>(resetKey);

    if (!record?.userId) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const hashedPassword = await bcrypt.hash(newPass, 10);
    await this.authnRepo.updateUserPassword(record.userId, hashedPassword);
    await this.authnRepo.revokeAllUserTokens(record.userId);
    await this.redis.del(resetKey);

    await this.auditService.log({
      actorId: record.userId,
      eventType: 'password_reset_completed',
      targetType: 'user',
      targetId: record.userId,
    });

    return { message: 'Password updated successfully' };
  }

  // ─── Active Session Management (User Story 3) ──────────────────────────────

  private formatSession(session: any): SessionSummary {
    const { token: _token, tokenHash: _tokenHash, ...safeSession } = session;
    return safeSession as SessionSummary;
  }

  async getActiveSessions(userId: string): Promise<SessionSummary[]> {
    const sessions = await this.authnRepo.findActiveSessionsByUser(userId);
    return sessions.map((session) => this.formatSession(session));
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const revokedCount = await this.authnRepo.revokeUserSession(
      userId,
      sessionId,
    );
    if (revokedCount === 0) {
      throw new NotFoundException('Session not found');
    }

    await this.redis.del(IAM_REDIS_KEYS.session(sessionId));

    await this.auditService.log({
      actorId: userId,
      eventType: 'token_revoked',
      targetType: 'session',
      targetId: sessionId,
    });
  }

  async revokeAllSessions(userId: string): Promise<{ revokedCount: number }> {
    const count = await this.authnRepo.revokeAllUserSessions(userId);

    await this.auditService.log({
      actorId: userId,
      eventType: 'token_revoked',
      targetType: 'user',
      targetId: userId,
      metadata: { count, scope: 'all_sessions' },
    });

    return { revokedCount: count };
  }
}
