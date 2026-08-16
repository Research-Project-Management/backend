import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '@/modules/iam/authentication/auth.service';
import { AuthRepository } from '@/modules/iam/authentication/auth.repository';
import * as bcrypt from 'bcrypt';



jest.mock('bcrypt');

describe('AuthService', () => {
  let service: AuthService;
  let authRepo: AuthRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        {
          provide: AuthRepository,
          useValue: {
            findUserByEmail: jest.fn(),
            findUserById: jest.fn(),
            findUserByOAuth: jest.fn(),
            createUser: jest.fn(),
            updateUser: jest.fn(),
            searchUsers: jest.fn(),
            createRefreshToken: jest.fn(),
            findRefreshToken: jest.fn(),
            revokeRefreshToken: jest.fn(),
          },
        },
        {
          provide: JwtService,
          useValue: {
            signAsync: jest.fn().mockResolvedValue('mock-token'),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn().mockImplementation((key) => {
              if (key === 'JWT_SECRET') return 'test-secret';
              if (key === 'JWT_REFRESH_SECRET') return 'test-refresh-secret';
              return null;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
    authRepo = module.get<AuthRepository>(AuthRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should throw BadRequestException if email already registered', async () => {
    (authRepo.findUserByEmail as jest.Mock).mockResolvedValue({
      id: '1',
      email: 'test@example.com',
    });

    await expect(
      service.registerUser({
        email: 'test@example.com',
        password: 'password123',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('should register a new user successfully', async () => {
    (authRepo.findUserByEmail as jest.Mock).mockResolvedValue(null);
    (bcrypt.hash as jest.Mock).mockResolvedValue('hashed-password');
    (authRepo.createUser as jest.Mock).mockResolvedValue({
      id: 'user-1',
      email: 'new@example.com',
      name: 'New User',
      password: 'hashed-password',
    });

    const result = await service.registerUser({
      email: 'new@example.com',
      password: 'password123',
      name: 'New User',
    });

    expect(result.user.email).toBe('new@example.com');
    expect(result.user.id).toBe('user-1');
    expect(result.accessToken).toBe('mock-token');
    expect(result.refreshToken).toBe('mock-token');
  });

  it('should throw UnauthorizedException on invalid login password', async () => {
    (authRepo.findUserByEmail as jest.Mock).mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      password: 'hashed-password',
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    await expect(
      service.login({ email: 'user@example.com', password: 'wrong-password' }),
    ).rejects.toThrow(UnauthorizedException);
  });
});
