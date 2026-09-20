import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import {
  User,
  AuthProvider,
  AuditOutcome,
  AuditSeverity,
} from '@prisma/client';

import { AuthRepository } from './auth.repository';
import { UserService } from '../user/user.service';
import { AuditService } from '../audit/audit.service';
import { AUDIT_ACTIONS } from '../audit/types/audit.type';
import { RedisCacheService } from '@/core/cache/redis.service';
import { PrismaService } from '@/core/database/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import {
  AuthnResponseDto,
  TokenRefreshResponseDto,
  UserSummaryResponseDto,
} from './dto/response.dto';
import { IDENTITY_REDIS_KEYS } from '../core/constants/identity.constant';

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
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly authnRepo: AuthRepository,
    private readonly userService: UserService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redis: RedisCacheService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
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
  formatUser(
    user: User & { profile?: { name: string; avatar: string | null } | null },
  ): UserSummaryResponseDto;
  formatUser(
    user:
      | (User & { profile?: { name: string; avatar: string | null } | null })
      | null
      | undefined,
  ): UserSummaryResponseDto | null;
  formatUser(
    user:
      | (User & { profile?: { name: string; avatar: string | null } | null })
      | null
      | undefined,
  ): UserSummaryResponseDto | null {
    if (!user) return null;
    const { password: _password, profile, ...rest } = user as any;
    return {
      ...rest,
      name: profile?.name ?? (user as any).name ?? 'User',
      avatar: profile?.avatar ?? (user as any).avatar ?? null,
      isVerified: user.status === 'active',
    };
  }

  private getRefreshTokenExpiresAt(): Date {
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    return expiresAt;
  }

  private async signTokenPair(user: {
    id: string;
    email: string | null;
    name?: string;
    status?: string;
    profile?: { name?: string; avatar?: string | null } | null;
  }): Promise<TokenPair> {
    const isVerified = user.status === 'active';
    const payload = {
      sub: user.id,
      id: user.id,
      email: user.email,
      name: user.name ?? user.profile?.name ?? 'User',
      status: user.status || 'active',
      isVerified,
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
    user: {
      id: string;
      email: string | null;
      name?: string;
      status?: string;
      profile?: { name?: string; avatar?: string | null } | null;
    },
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
    const sessionCacheKey = IDENTITY_REDIS_KEYS.session(session.id);
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
    const key = IDENTITY_REDIS_KEYS.oauthState(state);
    await this.redis.set(key, { createdAt: Date.now() }, 300); // 5 minutes TTL
    return state;
  }

  async verifyOAuthState(state?: string): Promise<boolean> {
    if (!state) return false;
    const key = IDENTITY_REDIS_KEYS.oauthState(state);
    const record = await this.redis.get<{ createdAt: number }>(key);
    if (!record) return false;
    await this.redis.del(key);
    return true;
  }

  async createOAuthExchangeTicket(data: AuthnResponseDto): Promise<string> {
    const ticket = crypto.randomBytes(32).toString('hex');
    const key = IDENTITY_REDIS_KEYS.oauthTicket(ticket);
    await this.redis.set(key, data, 60); // 60 seconds TTL
    return ticket;
  }

  async exchangeOAuthTicket(ticket: string): Promise<AuthnResponseDto> {
    if (!ticket) {
      throw new UnauthorizedException('OAuth exchange ticket is required');
    }
    const key = IDENTITY_REDIS_KEYS.oauthTicket(ticket);
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

      const tokenData = (await tokenRes.json()) as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };
      if (!tokenData.access_token) {
        this.logger.error(
          `Google token exchange failed: ${tokenData.error || 'unknown'} - ${tokenData.error_description || JSON.stringify(tokenData)}`,
        );
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
    const federatedRecord = await this.userService.findFederatedIdentity(
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
        if (!profile.email) {
          throw new BadRequestException(
            `A verified email address is required from ${profile.provider} to complete account registration.`,
          );
        }
        // Create new user profile with atomic settings initialization
        user = await this.authnRepo.createUser({
          email: profile.email.toLowerCase(),
          status: 'active',
          settings: {
            create: {},
          },
          profile: {
            create: {
              name: profile.name || 'User',
              avatar: profile.avatar || null,
            },
          },
        });
      }

      // Link federated identity
      await this.userService.linkFederatedIdentity({
        userId: user.id,
        provider: providerEnum,
        providerSubjectId: profile.id,
        email: profile.email?.toLowerCase(),
        profileData: { name: profile.name, avatar: profile.avatar },
      });

      await this.auditService.record({
        actorId: user.id,
        action: AUDIT_ACTIONS.AUTH_OAUTH_ACCOUNT_LINKED,
        outcome: AuditOutcome.success,
        severity: AuditSeverity.info,
        targetType: 'user',
        targetId: user.id,
        metadata: { provider: profile.provider },
      });
    }

    if (user.status !== 'active') {
      await this.auditService.record({
        actorId: user.id,
        action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
        outcome: AuditOutcome.denied,
        severity: AuditSeverity.warning,
        targetType: 'user',
        targetId: user.id,
        metadata: { method: `oauth_${profile.provider}`, status: user.status },
      });
      if (user.status === 'suspended') {
        throw new ForbiddenException(
          'Account has been suspended. Please contact support.',
        );
      }
      if (user.status === 'deactivated') {
        throw new ForbiddenException('Account has been deactivated.');
      }
      throw new UnauthorizedException(`Account is ${user.status}.`);
    }

    const tokens = await this.generateTokens(user);

    await this.auditService.record({
      actorId: user.id,
      action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCESS,
      outcome: AuditOutcome.success,
      severity: AuditSeverity.info,
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
      email: dto.email.toLowerCase().trim(),
      password: hashedPassword,
      status: 'pending_verification',
      settings: {
        create: {},
      },
      profile: {
        create: {
          name: dto.name || 'User',
          avatar: dto.avatar || null,
        },
      },
    });

    // Generate cryptographic email verification token
    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await this.prisma.verificationToken.create({
      data: {
        userId: user.id,
        tokenHash,
        type: 'email_verification',
        expiresAt,
      },
    });

    await this.auditService.record({
      actorId: user.id,
      action: AUDIT_ACTIONS.AUTH_EMAIL_VERIFICATION_REQUESTED,
      outcome: AuditOutcome.success,
      severity: AuditSeverity.info,
      targetType: 'user',
      targetId: user.id,
      metadata: { method: 'local_registration' },
    });

    // Soft Onboarding: Mint session tokens on registration so user can explore app immediately
    const tokens = await this.generateTokens(user);

    return {
      user: this.formatUser(user),
      ...tokens,
    };
  }

  async verifyEmail(rawToken: string): Promise<AuthnResponseDto> {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new BadRequestException('Verification token is required');
    }

    const tokenHash = this.hashToken(rawToken.trim());
    const tokenRecord = await this.prisma.verificationToken.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            profile: {
              select: {
                name: true,
                avatar: true,
              },
            },
          },
        },
      },
    });

    if (!tokenRecord) {
      throw new BadRequestException('Invalid or expired verification token');
    }

    if (tokenRecord.expiresAt < new Date()) {
      await this.prisma.verificationToken.delete({
        where: { id: tokenRecord.id },
      });
      throw new BadRequestException(
        'Verification token has expired. Please request a new verification link.',
      );
    }

    const user = tokenRecord.user;

    // Transition user to active and remove all verification tokens in transaction
    const activatedUser = await this.prisma.$transaction(async (tx) => {
      await tx.verificationToken.deleteMany({
        where: { userId: user.id, type: 'email_verification' },
      });

      return tx.user.update({
        where: { id: user.id },
        data: { status: 'active' },
        include: {
          profile: {
            select: {
              name: true,
              avatar: true,
            },
          },
        },
      });
    });

    await this.auditService.record({
      actorId: user.id,
      action: AUDIT_ACTIONS.AUTH_EMAIL_VERIFIED,
      outcome: AuditOutcome.success,
      severity: AuditSeverity.info,
      targetType: 'user',
      targetId: user.id,
      metadata: { method: 'token' },
    });

    // Mint session tokens upon successful email activation
    const tokens = await this.generateTokens(activatedUser);

    return {
      user: this.formatUser(activatedUser),
      ...tokens,
    };
  }

  async resendVerification(email: string): Promise<{ message: string }> {
    if (!email) {
      throw new BadRequestException('Email is required');
    }

    const user = await this.authnRepo.findUserByEmail(
      email.toLowerCase().trim(),
    );
    // Return generic message to prevent email enumeration
    if (!user || user.status !== 'pending_verification') {
      return {
        message:
          'If an account pending verification exists with this email, a verification link has been sent.',
      };
    }

    // Invalidate previous verification tokens
    await this.prisma.verificationToken.deleteMany({
      where: { userId: user.id, type: 'email_verification' },
    });

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await this.prisma.verificationToken.create({
      data: {
        userId: user.id,
        tokenHash,
        type: 'email_verification',
        expiresAt,
      },
    });

    await this.auditService.record({
      actorId: user.id,
      action: AUDIT_ACTIONS.AUTH_EMAIL_VERIFICATION_REQUESTED,
      outcome: AuditOutcome.success,
      severity: AuditSeverity.info,
      targetType: 'user',
      targetId: user.id,
      metadata: { method: 'resend' },
    });

    return {
      message:
        'If an account pending verification exists with this email, a verification link has been sent.',
    };
  }

  async register(dto: RegisterDto): Promise<AuthnResponseDto> {
    return this.registerUser(dto);
  }

  async login(dto: LoginDto): Promise<AuthnResponseDto> {
    const user = await this.authnRepo.findUserByEmail(dto.email);

    if (!user || !user.password) {
      await this.auditService.record({
        action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
        outcome: AuditOutcome.failure,
        severity: AuditSeverity.warning,
        targetType: 'user',
        metadata: { email: dto.email, reason: 'user_not_found_or_no_password' },
      });
      throw new UnauthorizedException('Invalid email or password');
    }

    const isMatch = await bcrypt.compare(dto.password, user.password);
    if (!isMatch) {
      await this.auditService.record({
        actorId: user.id,
        action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
        outcome: AuditOutcome.failure,
        severity: AuditSeverity.warning,
        targetType: 'user',
        targetId: user.id,
        metadata: { email: dto.email, reason: 'password_mismatch' },
      });
    }

    if (user.status === 'suspended') {
      await this.auditService.record({
        actorId: user.id,
        action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
        outcome: AuditOutcome.denied,
        severity: AuditSeverity.warning,
        targetType: 'user',
        targetId: user.id,
        metadata: {
          email: dto.email,
          status: user.status,
          reason: 'account_suspended',
        },
      });
      throw new ForbiddenException(
        'Your account has been suspended. Please contact support.',
      );
    }

    if (user.status === 'deactivated') {
      await this.auditService.record({
        actorId: user.id,
        action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
        outcome: AuditOutcome.denied,
        severity: AuditSeverity.warning,
        targetType: 'user',
        targetId: user.id,
        metadata: {
          email: dto.email,
          status: user.status,
          reason: 'account_deactivated',
        },
      });
      throw new ForbiddenException('This account has been deactivated.');
    }

    // Soft Onboarding: Allow pending_verification users to log in with progressive gating
    const tokens = await this.generateTokens(user);

    await this.auditService.record({
      actorId: user.id,
      action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCESS,
      outcome: AuditOutcome.success,
      severity: AuditSeverity.info,
      targetType: 'user',
      targetId: user.id,
      metadata: {
        method: 'password',
        isVerified: user.status === 'active',
      },
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

    // 1. Check Redis grace period cache (Optional performance accelerator)
    try {
      const cached = await this.redis.get<TokenRefreshResponseDto>(
        IDENTITY_REDIS_KEYS.graceToken(tokenHash),
      );
      if (cached) {
        this.logger.debug(
          `Serving cached token refresh from Redis grace window (hash: ${tokenHash.slice(0, 8)}...)`,
        );
        return cached;
      }
    } catch {
      // Redis offline or failed - fallback silently to database
    }

    const tokenRecord = await this.authnRepo.findRefreshToken(tokenHash);

    // 2. BREACH DETECTION with Pure Database Grace Period (Self-contained in PostgreSQL)
    if (tokenRecord && (tokenRecord.isRevoked || tokenRecord.revokedAt)) {
      const GRACE_PERIOD_MS = 30_000; // 30-second leeway window (OAuth 2.0 Security BCP)
      const revokedTime = tokenRecord.revokedAt
        ? new Date(tokenRecord.revokedAt).getTime()
        : 0;
      const isWithinGrace =
        revokedTime > 0 && Date.now() - revokedTime < GRACE_PERIOD_MS;

      if (isWithinGrace) {
        this.logger.log(
          `Token refresh grace period active in database (familyId: ${tokenRecord.familyId}). Handling concurrent tab refresh safely.`,
        );

        if (tokenRecord.user.status !== 'active') {
          throw new ForbiddenException(
            `Account is ${tokenRecord.user.status}.`,
          );
        }

        // Find the active child token generated during the rotation of this token
        const childToken = await this.prisma.refreshToken.findFirst({
          where: {
            parentId: tokenRecord.id,
            isRevoked: false,
            expiresAt: { gt: new Date() },
          },
          include: {
            user: {
              include: {
                profile: {
                  select: {
                    name: true,
                    avatar: true,
                  },
                },
              },
            },
          },
        });

        if (childToken) {
          // Re-sign token pair for this concurrent tab within the same lineage
          const freshTokens = await this.signTokenPair(childToken.user);
          const freshHash = this.hashToken(freshTokens.refreshToken);

          // Create a valid sibling session to keep both tabs alive independently
          await this.authnRepo.createSession({
            userId: childToken.userId,
            tokenHash: freshHash,
            familyId: childToken.familyId,
            parentId: tokenRecord.id,
            expiresAt: this.getRefreshTokenExpiresAt(),
          });

          const response: TokenRefreshResponseDto = {
            accessToken: freshTokens.accessToken,
            refreshToken: freshTokens.refreshToken,
            user: this.formatUser(childToken.user),
          };

          // Cache in Redis for instant subsequent responses if available
          try {
            await this.redis.set(
              IDENTITY_REDIS_KEYS.graceToken(tokenHash),
              response,
              30,
            );
          } catch {
            // Redis error safely ignored
          }

          return response;
        }
      }

      // OUTSIDE GRACE PERIOD (> 30s): Real Replay Attack! Terminate token family immediately.
      if (tokenRecord.familyId) {
        await this.authnRepo.revokeFamily(tokenRecord.familyId);
      } else {
        await this.authnRepo.revokeAllUserTokens(tokenRecord.userId);
      }
      try {
        await this.redis.set(
          IDENTITY_REDIS_KEYS.revoked(tokenRecord.userId),
          Date.now(),
          7 * 86400,
        );
      } catch {
        // Non-critical: Redis revocation write failure is tolerated
      }

      await this.auditService.record({
        actorId: tokenRecord.userId,
        action: AUDIT_ACTIONS.AUTH_TOKEN_BREACH_DETECTED,
        outcome: AuditOutcome.failure,
        severity: AuditSeverity.critical,
        targetType: 'session',
        targetId: tokenRecord.id,
        metadata: {
          familyId: tokenRecord.familyId,
          reason: 'revoked_token_replay_outside_grace',
        },
      });

      throw new UnauthorizedException(
        'Compromised session detected. All sessions in this token family have been terminated. Please log in again.',
      );
    }

    if (!tokenRecord || tokenRecord.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token is invalid or expired');
    }

    if (tokenRecord.user.status !== 'active') {
      await this.auditService.record({
        actorId: tokenRecord.userId,
        action: AUDIT_ACTIONS.AUTH_TOKEN_REVOKED,
        outcome: AuditOutcome.denied,
        severity: AuditSeverity.warning,
        targetType: 'session',
        targetId: tokenRecord.id,
        metadata: {
          status: tokenRecord.user.status,
          reason: 'inactive_user_refresh_attempt',
        },
      });
      throw new ForbiddenException(
        `Account is ${tokenRecord.user.status}. Session has been terminated.`,
      );
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

    const response: TokenRefreshResponseDto = {
      accessToken: newTokens.accessToken,
      refreshToken: newTokens.refreshToken,
      user: this.formatUser(tokenRecord.user),
    };

    // Cache in Redis with 30s TTL to accelerate concurrent requests from other tabs
    try {
      await this.redis.set(
        IDENTITY_REDIS_KEYS.graceToken(tokenHash),
        response,
        30,
      );
    } catch {
      // Redis optional cache write failure ignored safely
    }

    await this.auditService.record({
      actorId: tokenRecord.userId,
      action: AUDIT_ACTIONS.AUTH_TOKEN_REFRESHED,
      outcome: AuditOutcome.success,
      severity: AuditSeverity.info,
      targetType: 'session',
      targetId: tokenRecord.id,
      metadata: { familyId },
    });

    return response;
  }

  async logout(refreshToken?: string): Promise<{ message: string }> {
    if (refreshToken) {
      const tokenHash = this.hashToken(refreshToken);
      const tokenRecord = await this.authnRepo.findRefreshToken(tokenHash);
      if (tokenRecord) {
        await this.authnRepo.revokeRefreshToken(tokenHash);
        await this.redis.del(IDENTITY_REDIS_KEYS.session(tokenRecord.id));
        await this.redis.set(
          IDENTITY_REDIS_KEYS.revoked(tokenRecord.userId),
          Date.now(),
          7 * 86400,
        );

        await this.auditService.record({
          actorId: tokenRecord.userId,
          action: AUDIT_ACTIONS.AUTH_LOGOUT,
          outcome: AuditOutcome.success,
          severity: AuditSeverity.info,
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
    const resetKey = IDENTITY_REDIS_KEYS.passwordReset(resetToken);
    await this.redis.set(resetKey, { userId: user.id }, 900); // 15 min TTL

    await this.auditService.record({
      actorId: user.id,
      action: AUDIT_ACTIONS.AUTH_PASSWORD_RESET_REQUESTED,
      outcome: AuditOutcome.success,
      severity: AuditSeverity.info,
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
    const resetKey = IDENTITY_REDIS_KEYS.passwordReset(token);
    const record = await this.redis.get<{ userId: string }>(resetKey);

    if (!record?.userId) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    const hashedPassword = await bcrypt.hash(newPass, 10);
    await this.authnRepo.updateUserPassword(record.userId, hashedPassword);
    await this.authnRepo.revokeAllUserTokens(record.userId);
    await this.redis.set(
      IDENTITY_REDIS_KEYS.revoked(record.userId),
      Date.now(),
      7 * 86400,
    );
    await this.redis.del(resetKey);

    await this.auditService.record({
      actorId: record.userId,
      action: AUDIT_ACTIONS.AUTH_PASSWORD_RESET_COMPLETED,
      outcome: AuditOutcome.success,
      severity: AuditSeverity.info,
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

    await this.redis.del(IDENTITY_REDIS_KEYS.session(sessionId));
    await this.redis.set(
      IDENTITY_REDIS_KEYS.revoked(userId),
      Date.now(),
      7 * 86400,
    );

    await this.auditService.record({
      actorId: userId,
      action: AUDIT_ACTIONS.AUTH_TOKEN_REVOKED,
      outcome: AuditOutcome.success,
      severity: AuditSeverity.info,
      targetType: 'session',
      targetId: sessionId,
    });
  }

  async revokeAllSessions(userId: string): Promise<{ revokedCount: number }> {
    const count = await this.authnRepo.revokeAllUserSessions(userId);
    await this.redis.set(
      IDENTITY_REDIS_KEYS.revoked(userId),
      Date.now(),
      7 * 86400,
    );

    await this.auditService.record({
      actorId: userId,
      action: AUDIT_ACTIONS.AUTH_TOKEN_REVOKED,
      outcome: AuditOutcome.success,
      severity: AuditSeverity.warning,
      targetType: 'user',
      targetId: userId,
      metadata: { count, scope: 'all_sessions' },
    });

    return { revokedCount: count };
  }
}

export const AuthnService = AuthService;
export type AuthnService = AuthService;
