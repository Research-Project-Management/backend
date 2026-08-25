import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UserSummaryResponseDto {
  @ApiProperty({ description: 'User unique identifier', example: 'usr_123456789' })
  id!: string;

  @ApiPropertyOptional({ description: 'User email address', example: 'researcher@flux.ac.uk', nullable: true })
  email?: string | null;

  @ApiProperty({ description: 'User display name', example: 'Dr. Alan Turing' })
  name!: string;

  @ApiPropertyOptional({ description: 'User avatar URL', example: 'https://cdn.flux.ai/avatars/user.png', nullable: true })
  avatar?: string | null;

  @ApiProperty({ description: 'Email verification status', example: true })
  isVerified!: boolean;

  @ApiPropertyOptional({ description: 'User creation timestamp' })
  createdAt?: Date;

  @ApiPropertyOptional({ description: 'User last updated timestamp' })
  updatedAt?: Date;
}

export class AuthnResponseDto {
  @ApiProperty({ description: 'Authenticated user profile', type: UserSummaryResponseDto })
  user!: UserSummaryResponseDto;

  @ApiProperty({ description: 'Signed JWT Access Token (Short-lived)', example: 'eyJhbGciOiJIUzI1Ni...' })
  accessToken!: string;

  @ApiProperty({ description: 'Signed JWT Refresh Token (Long-lived)', example: 'eyJhbGciOiJIUzI1Ni...' })
  refreshToken!: string;
}

export class TokenRefreshResponseDto {
  @ApiProperty({ description: 'Signed JWT Access Token', example: 'eyJhbGciOiJIUzI1Ni...' })
  accessToken!: string;

  @ApiProperty({ description: 'New signed JWT Refresh Token', example: 'eyJhbGciOiJIUzI1Ni...' })
  refreshToken!: string;

  @ApiPropertyOptional({ description: 'Authenticated user profile', type: UserSummaryResponseDto })
  user?: UserSummaryResponseDto | null;
}

export class MessageResponseDto {
  @ApiProperty({ description: 'Status message', example: 'Operation completed successfully' })
  message!: string;
}

// Aliases for backward compatibility
export const AuthResponseDto = AuthnResponseDto;
export type AuthResponseDto = AuthnResponseDto;
