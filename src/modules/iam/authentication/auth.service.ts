import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthRepository } from './auth.repository';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { User } from '@prisma/client';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * Enterprise Authentication & Identity Service.
 * Manages user credentials, JWT lifecycle, OAuth state validation,
 * cryptographic token hashing, and breach reuse detection.
 */
@Injectable()
export class AuthService {
  // In-Memory Short-Lived Caches for OAuth Security (Auto-pruned)
  private readonly oauthStates = new Map<string, number>();
  private readonly oauthExchangeTickets = new Map<
    string,
    { data: { accessToken: string; refreshToken: string; user: any }; expiresAt: number }
  >();

  constructor(
    private readonly authRepo: AuthRepository,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Prunes expired OAuth states and exchange tickets to maintain bounded memory usage.
   */
  private pruneExpiredOAuthData(): void {
    const now = Date.now();
    for (const [state, expiry] of this.oauthStates.entries()) {
      if (expiry <= now) this.oauthStates.delete(state);
    }
    for (const [ticket, record] of this.oauthExchangeTickets.entries()) {
      if (record.expiresAt <= now) this.oauthExchangeTickets.delete(ticket);
    }
  }

  /**
   * Cryptographically hashes a refresh token before persistence.
   * Prevents plain-text token extraction in case of database compromise.
   */
  private hashToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  /**
   * Strips sensitive credential fields (like password) from user domain entity.
   */
  private formatUser(user: User): Omit<User, 'password'>;
  private formatUser(user: null | undefined): null;
  private formatUser(
    user: User | null | undefined,
  ): Omit<User, 'password'> | null;
  private formatUser(user: User | null | undefined) {
    if (!user) return null;
    const { password, ...rest } = user;
    return rest;
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

    const accessTokenSecret =
      this.configService.get<string>('JWT_SECRET') || process.env.JWT_SECRET;
    const refreshTokenSecret =
      this.configService.get<string>('JWT_REFRESH_SECRET') ||
      process.env.JWT_REFRESH_SECRET;

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

  /**
   * Generates a cryptographically random OAuth state with 5-minute TTL.
   */
  createOAuthState(): string {
    this.pruneExpiredOAuthData();
    const state = crypto.randomBytes(24).toString('hex');
    this.oauthStates.set(state, Date.now() + 5 * 60 * 1000);
    return state;
  }

  /**
   * Verifies OAuth state to protect against CSRF attacks.
   */
  verifyOAuthState(state?: string): boolean {
    if (!state) return false;
    const expiry = this.oauthStates.get(state);
    if (!expiry) return false;
    this.oauthStates.delete(state);
    return expiry > Date.now();
  }

  /**
   * Creates a single-use 60-second exchange ticket for OAuth tokens.
   */
  createOAuthExchangeTicket(data: {
    accessToken: string;
    refreshToken: string;
    user: any;
  }): string {
    this.pruneExpiredOAuthData();
    const ticket = crypto.randomBytes(32).toString('hex');
    this.oauthExchangeTickets.set(ticket, {
      data,
      expiresAt: Date.now() + 60 * 1000,
    });
    return ticket;
  }

  /**
   * Burns single-use exchange ticket and returns session payload securely.
   */
  exchangeOAuthTicket(ticket: string) {
    if (!ticket) {
      throw new UnauthorizedException('OAuth exchange ticket is required');
    }
    const record = this.oauthExchangeTickets.get(ticket);
    if (!record || record.expiresAt < Date.now()) {
      this.oauthExchangeTickets.delete(ticket);
      throw new UnauthorizedException('OAuth exchange ticket is invalid or expired');
    }
    this.oauthExchangeTickets.delete(ticket);
    return record.data;
  }

  /**
   * Registers a new user with bcrypt-hashed password and returns initial session.
   */
  async registerUser(dto: RegisterDto) {
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
  async login(dto: LoginDto) {
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
  async refresh(refreshToken: string) {
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
  async logout(refreshToken?: string) {
    if (refreshToken) {
      const tokenHash = this.hashToken(refreshToken);
      await this.authRepo.revokeRefreshToken(tokenHash);
    }
    return { message: 'Logged out successfully' };
  }

  /**
   * Retrieves profile for the specified user ID.
   */
  async getMe(userId: string) {
    const user = await this.authRepo.findUserById(userId);

    if (!user) {
      throw new NotFoundException('User not found');
    }

    return { user: this.formatUser(user) };
  }

  /**
   * Updates user name and avatar.
   */
  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.authRepo.updateUser(userId, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.avatar !== undefined && { avatar: dto.avatar }),
    });

    return { user: this.formatUser(user) };
  }

  /**
   * Verifies current password and sets new bcrypt-hashed password.
   */
  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.authRepo.findUserById(userId);

    if (!user || !user.password) {
      throw new BadRequestException('User has no password set');
    }

    const isMatch = await bcrypt.compare(dto.currentPassword, user.password);
    if (!isMatch) {
      throw new BadRequestException('Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, 10);
    await this.authRepo.updateUser(userId, {
      password: hashedPassword,
    });

    return { message: 'Password updated successfully' };
  }

  /**
   * Searches for users by name or email with pagination.
   */
  async searchUsers(query: string, currentUserId?: string) {
    const users = await this.authRepo.searchUsers(query, currentUserId);
    return { users };
  }

  /**
   * Handles OAuth profile resolution, auto-registration, and token provisioning.
   */
  async handleOAuth(profile: {
    id: string;
    email?: string;
    name?: string;
    avatar?: string;
    provider: 'google' | 'github';
  }) {
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
}

export { AuthService as AuthenticationService };
