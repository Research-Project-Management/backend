import {
  ArgumentsHost,
  NotFoundException,
  BadRequestException,
  HttpStatus,
} from '@nestjs/common';
import { GlobalExceptionFilter } from '@/core/filters/global-exception.filter';

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;
  let mockStatus: jest.Mock;
  let mockSend: jest.Mock;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    mockSend = jest.fn();
    mockStatus = jest.fn().mockReturnValue({ send: mockSend });
  });

  function createMockHost(url = '/api/test'): ArgumentsHost {
    return {
      switchToHttp: () => ({
        getResponse: () => ({
          status: mockStatus,
          sent: false,
          raw: { headersSent: false },
        }),
        getRequest: () => ({
          url,
        }),
      }),
    } as unknown as ArgumentsHost;
  }

  it('should format HttpException into standard error envelope', () => {
    const host = createMockHost('/api/workspaces/123');
    const exception = new NotFoundException('Workspace not found');

    filter.catch(exception, host);

    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: {
          code: 'NOT_FOUND',
          message: 'Workspace not found',
          details: undefined,
        },
        statusCode: 404,
        path: '/api/workspaces/123',
      }),
    );
  });

  it('should format validation errors into VALIDATION_ERROR code', () => {
    const host = createMockHost('/api/workspaces');
    const exception = new BadRequestException({
      message: ['Name must not be empty', 'URL is required'],
      error: 'Bad Request',
      statusCode: 400,
    });

    filter.catch(exception, host);

    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Name must not be empty',
          details: ['Name must not be empty', 'URL is required'],
        },
        statusCode: 400,
      }),
    );
  });

  it('should format Prisma P2002 error into UNIQUE_CONSTRAINT_VIOLATION', () => {
    const host = createMockHost('/api/users');
    const prismaError = {
      code: 'P2002',
      message: 'Unique constraint failed on the fields: (`email`)',
      meta: { target: ['email'] },
    };

    filter.catch(prismaError, host);

    expect(mockStatus).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: {
          code: 'UNIQUE_CONSTRAINT_VIOLATION',
          message: 'A record with this identifier already exists',
          details: { target: ['email'] },
        },
        statusCode: 409,
      }),
    );
  });
});
