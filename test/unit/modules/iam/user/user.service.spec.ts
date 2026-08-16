import { Test, TestingModule } from '@nestjs/testing';
import { UserService } from '@/modules/iam/user/user.service';
import { UserRepository } from '@/modules/iam/user/user.repository';

describe('UserService', () => {
  let service: UserService;
  let repo: UserRepository;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        {
          provide: UserRepository,
          useValue: {
            findUserById: jest.fn(),
            updateUser: jest.fn(),
            searchUsers: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
    repo = module.get<UserRepository>(UserRepository);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should get current user without password', async () => {
    (repo.findUserById as jest.Mock).mockResolvedValue({
      id: 'u-1',
      name: 'John',
      email: 'john@example.com',
      password: 'hashed_password',
      avatar: null,
    });

    const result = await service.getMe('u-1');
    expect(result.user).toBeDefined();
    expect(result.user?.name).toBe('John');
    expect((result.user as any)?.password).toBeUndefined();
  });

  it('should search users by query', async () => {
    (repo.searchUsers as jest.Mock).mockResolvedValue([
      { id: 'u-2', name: 'Alice', email: 'alice@example.com', avatar: null },
    ]);

    const result = await service.searchUsers('Ali', 'u-1');
    expect(result.users.length).toBe(1);
    expect(result.users[0].name).toBe('Alice');
  });
});
