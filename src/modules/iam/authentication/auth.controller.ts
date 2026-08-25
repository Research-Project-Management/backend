import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  Redirect,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBadRequestResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { OAuthExchangeDto } from './dto/oauth-exchange.dto';
import {
  AuthResponseDto,
  TokenRefreshResponseDto,
  MessageResponseDto,
} from './dto/auth-response.dto';
import { Public } from './decorators/public.decorator';

@ApiTags('Identity')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new user account' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'User registered successfully',
    type: AuthResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Email already exists or invalid data' })
  async register(@Body() dto: RegisterDto): Promise<AuthResponseDto> {
    return this.authService.registerUser(dto);
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Authenticate user with email and password' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Login successful',
    type: AuthResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password' })
  async login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.authService.login(dto);
  }

  @Public()
  @Get('google')
  @Redirect()
  @ApiOperation({ summary: 'Initiate Google OAuth2 authentication flow' })
  async googleAuth() {
    const url = await this.authService.getGoogleAuthUrl();
    return { url, statusCode: 302 };
  }

  @Public()
  @Get('google/callback')
  @Redirect()
  @ApiOperation({ summary: 'Handle Google OAuth2 callback' })
  async googleCallback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    const result = await this.authService.handleGoogleCallback(
      code,
      state,
      error,
    );
    return { url: result.redirectUrl, statusCode: 302 };
  }

  @Public()
  @Get('github')
  @Redirect()
  @ApiOperation({ summary: 'Initiate GitHub OAuth authentication flow' })
  async githubAuth() {
    const url = await this.authService.getGithubAuthUrl();
    return { url, statusCode: 302 };
  }

  @Public()
  @Get('github/callback')
  @Redirect()
  @ApiOperation({ summary: 'Handle GitHub OAuth callback' })
  async githubCallback(
    @Query('code') code?: string,
    @Query('state') state?: string,
    @Query('error') error?: string,
  ) {
    const result = await this.authService.handleGithubCallback(
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
    type: AuthResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Invalid or expired ticket' })
  async exchangeOAuthCode(
    @Body() body: OAuthExchangeDto,
  ): Promise<AuthResponseDto> {
    if (!body?.code) {
      throw new BadRequestException('Exchange code is required');
    }
    return this.authService.exchangeOAuthTicket(body.code);
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
    @Body() dto: RefreshTokenDto,
  ): Promise<TokenRefreshResponseDto> {
    return this.authService.refresh(dto.refreshToken);
  }

  @Public()
  @Get('logout')
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Revoke refresh token and terminate session' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Logged out successfully',
    type: MessageResponseDto,
  })
  async logout(@Body() dto?: RefreshTokenDto): Promise<MessageResponseDto> {
    return this.authService.logout(dto?.refreshToken);
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
  forgotPassword(@Body() _dto: ForgotPasswordDto): MessageResponseDto {
    return {
      message: 'If this email is registered, a reset link will be sent.',
    };
  }
}
