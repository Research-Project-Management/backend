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

import { AuthRepository } from './auth.repository';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import {
  AuthResponseDto,
  TokenRefreshResponseDto,
  UserSummaryResponseDto,
} from './dto/auth-response.dto';

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
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  // Redis Key Prefixes (following redis-core colon standard)
  private static readonly OAUTH_STATE_PREFIX = 'flux:iam:oauth_state';
  private static readonly OAUTH_TICKET_PREFIX = 'flux:iam:oauth_ticket';

  constructor(
    private readonly authRepo: AuthRepository,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly redis: RedisCacheService,
  ) {}

  /**
   * Cryptographically hashes a refresh token before persistence.
   * Prevents plain-text token extraction in case of database compromise.
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
   * Stores only the SHA-256 hashed refresh token in the database.
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

    await this.authRepo.createRefreshToken({
      userId: user.id,
      token: this.hashToken(refreshToken),
      expiresAt,
    });

    return { accessToken, refreshToken };
  }

  // ─── OAuth Redis State Management ──────────────────────────────────────────

  /**
   * Generates a cryptographically random OAuth state stored in Redis with 5-minute TTL.
   */
  async createOAuthState(): Promise<string> {
    const state = crypto.randomBytes(24).toString('hex');
    const key = `${AuthService.OAUTH_STATE_PREFIX}:${state}`;
    await this.redis.set(key, { createdAt: Date.now() }, 300); // 5 minutes TTL
    return state;
  }

  /**
   * Verifies OAuth state to protect against CSRF attacks, burning it on verification.
   */
  async verifyOAuthState(state?: string): Promise<boolean> {
    if (!state) return false;
    const key = `${AuthService.OAUTH_STATE_PREFIX}:${state}`;
    const record = await this.redis.get<{ createdAt: number }>(key);
    if (!record) return false;
    await this.redis.del(key);
    return true;
  }

  /**
   * Creates a single-use 60-second exchange ticket stored in Redis for OAuth tokens.
   */
  async createOAuthExchangeTicket(data: AuthResponseDto): Promise<string> {
    const ticket = crypto.randomBytes(32).toString('hex');
    const key = `${AuthService.OAUTH_TICKET_PREFIX}:${ticket}`;
    await this.redis.set(key, data, 60); // 60 seconds TTL
    return ticket;
  }

  /**
   * Burns single-use exchange ticket from Redis and returns session payload securely.
   */
  async exchangeOAuthTicket(ticket: string): Promise<AuthResponseDto> {
    if (!ticket) {
      throw new UnauthorizedException('OAuth exchange ticket is required');
    }
    const key = `${AuthService.OAUTH_TICKET_PREFIX}:${ticket}`;
    const data = await this.redis.get<AuthResponseDto>(key);
    if (!data) {
      throw new UnauthorizedException(
        'OAuth exchange ticket is invalid or expired',
      );
    }
    await this.redis.del(key);
    return data;
  }

  // ─── OAuth Provider Logic ──────────────────────────────────────────────────

  /**
   * Constructs Google OAuth2 Authorization URL.
   */
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

  /**
   * Handles Google OAuth callback token exchange and user provisioning.
   */
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
      this.logger.error(`Google OAuth failed: ${err}`);
      return { redirectUrl: `${clientUrl}/login?error=oauth_error` };
    }
  }

  /**
   * Constructs GitHub OAuth Authorization URL.
   */
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

  /**
   * Handles GitHub OAuth callback token exchange and user provisioning.
   */
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
      this.logger.error(`GitHub OAuth failed: ${err}`);
      return { redirectUrl: `${clientUrl}/login?error=oauth_error` };
    }
  }

  /**
   * Handles OAuth profile resolution, auto-registration, and token provisioning.
   */
  async handleOAuth(profile: OAuthUserProfile): Promise<AuthResponseDto> {
    const providerField: 'googleId' | 'githubId' =
      profile.provider === 'google' ? 'googleId' : 'githubId';

    let user = await this.authRepo.findUserByOAuth(
      providerField,
      profile.id,
      profile.email,
    );

    if (!user) {
      user = await this.authRepo.createUser({
        email: profile.email?.toLowerCase() || null,
        name: profile.name || 'User',
        avatar: profile.avatar || null,
        [providerField]: profile.id,
        isVerified: true,
      });
    } else if (!user[providerField]) {
      user = await this.authRepo.updateUser(user.id, {
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

  /**
   * Registers a new user with bcrypt-hashed password and returns initial session.
   */
  async registerUser(dto: RegisterDto): Promise<AuthResponseDto> {
    const existing = await this.authRepo.findUserByEmail(dto.email);

    if (existing) {
      throw new BadRequestException('Email is already registered');
    }

    const hashedPassword = await bcrypt.hash(dto.password, 10);
    const user = await this.authRepo.createUser({
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

  /**
   * Validates credentials and generates signed session tokens.
   */
  async login(dto: LoginDto): Promise<AuthResponseDto> {
    const user = await this.authRepo.findUserByEmail(dto.email);

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

  /**
   * Refreshes access token with Refresh Token Rotation & Reuse Detection (RFC 6749).
   */
  async refresh(refreshToken: string): Promise<TokenRefreshResponseDto> {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }

    const tokenHash = this.hashToken(refreshToken);
    const tokenRecord = await this.authRepo.findRefreshToken(tokenHash);

    // Reuse Detection: If a revoked token is presented, terminate all user sessions
    if (tokenRecord && tokenRecord.revokedAt) {
      await this.authRepo.revokeAllUserTokens(tokenRecord.userId);
      throw new UnauthorizedException(
        'Compromised session detected. All sessions terminated. Please log in again.',
      );
    }

    if (!tokenRecord || tokenRecord.expiresAt < new Date()) {
      throw new UnauthorizedException('Refresh token is invalid or expired');
    }

    // Token Rotation
    await this.authRepo.revokeRefreshToken(tokenHash);
    const newTokens = await this.generateTokens(tokenRecord.user);

    return {
      accessToken: newTokens.accessToken,
      refreshToken: newTokens.refreshToken,
      user: this.formatUser(tokenRecord.user),
    };
  }

  /**
   * Revokes refresh token in database.
   */
  async logout(refreshToken?: string): Promise<{ message: string }> {
    if (refreshToken) {
      const tokenHash = this.hashToken(refreshToken);
      await this.authRepo.revokeRefreshToken(tokenHash);
    }
    return { message: 'Logged out successfully' };
  }
}

export { AuthService as AuthenticationService };
