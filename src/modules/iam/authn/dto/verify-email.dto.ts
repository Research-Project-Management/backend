import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsEmail } from 'class-validator';

export class VerifyEmailDto {
  @ApiProperty({
    description: 'Cryptographic email verification token received via email',
    example: 'd9f8e7c6b5a4...',
  })
  @IsString()
  @IsNotEmpty()
  token!: string;
}

export class ResendVerificationDto {
  @ApiProperty({
    description: 'Email address of the account pending verification',
    example: 'researcher@flux.ac.uk',
  })
  @IsEmail()
  @IsNotEmpty()
  email!: string;
}
