import { Test, TestingModule } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthnService } from '@/modules/iam/authn/authn.service';
import { AuthnRepository } from '@/modules/iam/authn/authn.repository';
import { RedisCacheService } from '@/core/cache/redis-cache.service';
import * as bcrypt from 'bcrypt';

jest.mock('bcrypt');

describe('AuthnService', () => {
  let service: AuthnService;
  let authnRepo: AuthnRepository;
  let redis: RedisCacheService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthnService,
        {
          provide: AuthnRepository,
          useValue: {
            findUserByEmail: jest.fn(),
            findUserById: jest.fn(),
            findUserByOAuth: jest.fn(),
            createUser: jest.fn(),
            updateUser: jest.fn(),
            createRefreshToken: jest.fn(),
            findRefreshToken: jest.fn(),
            revokeRefreshToken: jest.fn(),
            revokeAllUserTokens: jest.fn(),
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
        {
          provide: RedisCacheService,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<AuthnService>(AuthnService);
    authnRepo = module.get<AuthnRepository>(AuthnRepository);
    redis = module.get<RedisCacheService>(RedisCacheService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should throw BadRequestException if email already registered', async () => {
    (authnRepo.findUserByEmail as jest.Mock).mockResolvedValue({
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
    (authnRepo.findUserByEmail as jest.Mock).mockResolvedValue(null);
    (bcrypt.hash as jest.Mock).mockResolvedValue('hashed-password');
    (authnRepo.createUser as jest.Mock).mockResolvedValue({
      id: 'user-1',
      email: 'new@example.com',
      name: 'New User',
      password: 'hashed-password',
      avatar: null,
      isVerified: true,
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
    (authnRepo.findUserByEmail as jest.Mock).mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      password: 'hashed-password',
    });
    (bcrypt.compare as jest.Mock).mockResolvedValue(false);

    await expect(
      service.login({ email: 'user@example.com', password: 'wrong-password' }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('should create and verify OAuth state in Redis', async () => {
    const state = await service.createOAuthState();
    expect(typeof state).toBe('string');
    expect(redis.set).toHaveBeenCalled();

    (redis.get as jest.Mock).mockResolvedValue({ createdAt: Date.now() });
    const isValid = await service.verifyOAuthState(state);
    expect(isValid).toBe(true);
    expect(redis.del).toHaveBeenCalled();
  });
});
