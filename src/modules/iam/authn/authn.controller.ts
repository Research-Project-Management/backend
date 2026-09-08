import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Req,
  Res,
  Redirect,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import { FastifyRequest, FastifyReply } from 'fastify';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AuthnService } from './authn.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { OAuthExchangeDto } from './dto/oauth-exchange.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import {
  AuthnResponseDto,
  TokenRefreshResponseDto,
  MessageResponseDto,
} from './dto/authn-response.dto';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { BypassEnvelope } from '@/core/decorators/bypass-envelope.decorator';

function extractRefreshTokenFromCookie(cookieHeader?: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)refresh_token=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function buildRefreshTokenCookie(
  token: string,
  maxAgeSeconds = 7 * 24 * 60 * 60,
): string {
  const isProd = process.env.NODE_ENV === 'production';
  const secure = isProd ? '; Secure' : '';
  return `refresh_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${maxAgeSeconds}`;
}

function buildClearRefreshTokenCookie(): string {
  const isProd = process.env.NODE_ENV === 'production';
  const secure = isProd ? '; Secure' : '';
  return `refresh_token=; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

@ApiTags('Identity')
@Controller(['auth', 'api/auth'])
@UseGuards(JwtAuthGuard)
export class AuthnController {
  constructor(private readonly authnService: AuthnService) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new user account' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'User registered successfully',
    type: AuthnResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Email already exists or invalid data',
  })
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthnResponseDto> {
    const result = await this.authnService.registerUser(dto);
    if (result?.refreshToken) {
      reply.header('Set-Cookie', buildRefreshTokenCookie(result.refreshToken));
    }
    return result;
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate user with email and password' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Login successful',
    type: AuthnResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password' })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthnResponseDto> {
    const result = await this.authnService.login(dto);
    if (result?.refreshToken) {
      reply.header('Set-Cookie', buildRefreshTokenCookie(result.refreshToken));
    }
    return result;
  }

  @Public()
  @BypassEnvelope()
  @Get('google')
  @Redirect()
  @ApiOperation({ summary: 'Initiate Google OAuth2 authentication flow' })
  async googleAuth() {
    const url = await this.authnService.getGoogleAuthUrl();
    return { url, statusCode: 302 };
  }

  @Public()
  @BypassEnvelope()
  @Get('google/callback')
  @Redirect()
  @ApiOperation({ summary: 'Handle Google OAuth2 callback' })
  async googleCallback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    const result = await this.authnService.handleGoogleCallback(
      code,
      state,
      error,
    );
    return { url: result.redirectUrl, statusCode: 302 };
  }

  @Public()
  @BypassEnvelope()
  @Get('github')
  @Redirect()
  @ApiOperation({ summary: 'Initiate GitHub OAuth authentication flow' })
  async githubAuth() {
    const url = await this.authnService.getGithubAuthUrl();
    return { url, statusCode: 302 };
  }

  @Public()
  @BypassEnvelope()
  @Get('github/callback')
  @Redirect()
  @ApiOperation({ summary: 'Handle GitHub OAuth callback' })
  async githubCallback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    const result = await this.authnService.handleGithubCallback(
      code,
      state,
      error,
    );
    return { url: result.redirectUrl, statusCode: 302 };
  }

  @Public()
  @Post('oauth/exchange')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Exchange single-use OAuth ticket for JWT credentials securely in POST body',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'OAuth ticket successfully exchanged',
    type: AuthnResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Invalid or expired ticket' })
  async exchangeOAuthCode(
    @Body() body: OAuthExchangeDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthnResponseDto> {
    if (!body?.code) {
      throw new BadRequestException('Exchange code is required');
    }
    const result = await this.authnService.exchangeOAuthTicket(body.code);
    if (result?.refreshToken) {
      reply.header('Set-Cookie', buildRefreshTokenCookie(result.refreshToken));
    }
    return result;
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Refresh access token with refresh token rotation',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'New tokens issued',
    type: TokenRefreshResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Invalid or expired refresh token' })
  async refresh(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() dto?: RefreshTokenDto,
  ): Promise<TokenRefreshResponseDto> {
    const tokenFromCookie = extractRefreshTokenFromCookie(req.headers.cookie);
    const token = dto?.refreshToken || tokenFromCookie;
    if (!token) {
      throw new BadRequestException('Refresh token is required');
    }
    const result = await this.authnService.refresh(token);
    if (result?.refreshToken) {
      reply.header('Set-Cookie', buildRefreshTokenCookie(result.refreshToken));
    }
    return result;
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke refresh token and terminate session' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Logged out successfully',
    type: MessageResponseDto,
  })
  async logout(
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Body() dto?: RefreshTokenDto,
  ): Promise<MessageResponseDto> {
    const tokenFromCookie = extractRefreshTokenFromCookie(req.headers.cookie);
    const token = dto?.refreshToken || tokenFromCookie;
    reply.header('Set-Cookie', buildClearRefreshTokenCookie());
    return this.authnService.logout(token || undefined);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request password reset email' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Password reset request acknowledged',
    type: MessageResponseDto,
  })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.authnService.forgotPassword(dto.email);
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm password reset using token from email' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Password reset successfully',
    type: MessageResponseDto,
  })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authnService.resetPassword(dto.token, dto.newPassword);
  }

  // ─── Active Sessions (User Story 3) ────────────────────────────────────────

  @Get('sessions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get all active sessions for current user' })
  async getActiveSessions(@CurrentUser('id') userId: string) {
    return this.authnService.getActiveSessions(userId);
  }

  @Post('sessions/:id/revoke')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke a specific active session' })
  async revokeSession(
    @CurrentUser('id') userId: string,
    @Param('id') sessionId: string,
  ) {
    await this.authnService.revokeSession(userId, sessionId);
    return { message: 'Session revoked successfully' };
  }

  @Post('sessions/revoke-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revoke all active sessions (Sign out of all devices)',
  })
  async revokeAllSessions(@CurrentUser('id') userId: string) {
    return this.authnService.revokeAllSessions(userId);
  }
}

// Backward compatibility alias
export const AuthController = AuthnController;
export type AuthController = AuthnController;
