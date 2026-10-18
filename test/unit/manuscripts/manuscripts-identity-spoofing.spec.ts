import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessConfigService } from '@/modules/project/access/config/access.config';
import { OperatorGuard } from '@/modules/project/access/guards/operator.guard';
import { TemplatesController } from '@/modules/manuscripts/templates/templates.controller';
import { CitationsController } from '@/modules/manuscripts/citations/citations.controller';
import { SpellingUtilityController } from '@/modules/manuscripts/spelling/spelling.controller';

describe('Identity Spoofing Immunity & Operator Authorization (SEC-06 / SEC-10 / US6)', () => {
  let accessConfigService: AccessConfigService;
  let operatorGuard: OperatorGuard;
  let mockConfigService: any;

  const operatorUserId = 'op-user-uuid-001';
  const normalUserId = 'normal-user-uuid-002';
  const spoofedUserId = 'spoofed-admin-uuid-003';

  beforeEach(() => {
    mockConfigService = {
      get: jest.fn((key: string) => {
        if (key === 'access') {
          return {
            enforcementMode: 'enforce',
            operatorUserIds: [operatorUserId],
          };
        }
        return undefined;
      }),
    };

    accessConfigService = new AccessConfigService(
      mockConfigService as ConfigService,
    );
    operatorGuard = new OperatorGuard(accessConfigService);
  });

  function createMockExecutionContext(
    user?: any,
    headers?: Record<string, string>,
  ): ExecutionContext {
    const request = {
      user,
      headers: headers || {},
      method: 'POST',
      url: '/test',
    };

    return {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => ({}),
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;
  }

  describe('OperatorGuard Enforcement', () => {
    it('should throw UnauthorizedException (401 AUTH_REQUIRED) if user is not authenticated', () => {
      const context = createMockExecutionContext(undefined, {
        'x-user-id': operatorUserId,
      });

      expect(() => operatorGuard.canActivate(context)).toThrow(
        UnauthorizedException,
      );
      try {
        operatorGuard.canActivate(context);
      } catch (err: any) {
        expect(err.getResponse()).toEqual({
          statusCode: 401,
          code: 'AUTH_REQUIRED',
          message: 'Authentication required',
        });
      }
    });

    it('should throw ForbiddenException (403 OPERATOR_REQUIRED) if user is authenticated but not an operator', () => {
      const context = createMockExecutionContext(
        { id: normalUserId },
        { 'x-user-id': operatorUserId }, // Attempted header spoof
      );

      expect(() => operatorGuard.canActivate(context)).toThrow(
        ForbiddenException,
      );
      try {
        operatorGuard.canActivate(context);
      } catch (err: any) {
        expect(err.getResponse()).toEqual({
          statusCode: 403,
          code: 'OPERATOR_REQUIRED',
          message: 'Operator privileges required',
        });
      }
    });

    it('should allow access when authenticated user is in operator allowlist', () => {
      const context = createMockExecutionContext({ id: operatorUserId });
      const result = operatorGuard.canActivate(context);
      expect(result).toBe(true);
    });

    it('should extract userId from sub or userId property if id is not present', () => {
      const contextWithSub = createMockExecutionContext({
        sub: operatorUserId,
      });
      expect(operatorGuard.canActivate(contextWithSub)).toBe(true);

      const contextWithUserId = createMockExecutionContext({
        userId: operatorUserId,
      });
      expect(operatorGuard.canActivate(contextWithUserId)).toBe(true);
    });
  });

  describe('Controller Identity Spoofing Immunity', () => {
    it('TemplatesController: instantiateTemplate should use JWT user and reject spoofed x-user-id', async () => {
      const mockTemplatesService = {
        instantiateTemplate: jest.fn().mockResolvedValue({ id: 'project-new' }),
      };
      const controller = new TemplatesController(mockTemplatesService as any);

      const reqWithSpoof = {
        user: { id: normalUserId },
        headers: { 'x-user-id': spoofedUserId },
      };

      await controller.instantiateTemplate(
        reqWithSpoof as any,
        {
          templateId: 'tmpl-1',
          title: 'My Project',
        } as any,
      );

      expect(mockTemplatesService.instantiateTemplate).toHaveBeenCalledWith(
        normalUserId, // Verified user ID from JWT, NOT spoofedUserId
        expect.anything(),
      );
    });

    it('TemplatesController: instantiateTemplate should throw UnauthorizedException if req.user is absent', async () => {
      const mockTemplatesService = {
        instantiateTemplate: jest.fn(),
      };
      const controller = new TemplatesController(mockTemplatesService as any);

      const reqWithoutUser = {
        headers: { 'x-user-id': operatorUserId },
      };

      await expect(
        controller.instantiateTemplate(
          reqWithoutUser as any,
          {
            templateId: 'tmpl-1',
            title: 'My Project',
          } as any,
        ),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('CitationsController: syncLibrary should use req.user.id and ignore x-user-id header', async () => {
      const mockCitationsService = {
        syncLibraryCollection: jest.fn().mockResolvedValue({
          importedCount: 5,
          updatedCount: 0,
          citationKeys: ['ref1'],
        }),
      };
      const controller = new CitationsController(mockCitationsService as any);

      const reqWithSpoof = {
        user: { id: normalUserId },
        headers: { 'x-user-id': spoofedUserId },
      };

      await controller.syncLibrary(
        'project-1',
        { provider: 'zotero' } as any,
        reqWithSpoof,
        { id: 'project-1' },
      );

      expect(mockCitationsService.syncLibraryCollection).toHaveBeenCalledWith(
        'project-1',
        normalUserId, // strictly authenticated user
        expect.anything(),
      );
    });

    it('SpellingUtilityController: user-dictionary should use req.user and reject unauthenticated requests', async () => {
      const mockSpellingService = {
        listUserWords: jest
          .fn()
          .mockResolvedValue({ words: ['latex', 'overleaf'], count: 2 }),
        learnUserWord: jest.fn().mockResolvedValue(undefined),
        unlearnUserWord: jest.fn().mockResolvedValue(true),
      };
      const controller = new SpellingUtilityController(
        mockSpellingService as any,
      );

      const reqWithSpoof = {
        user: { id: normalUserId },
        headers: { 'x-user-id': spoofedUserId },
      };

      const result = await controller.listUserDictionary(reqWithSpoof);
      expect(mockSpellingService.listUserWords).toHaveBeenCalledWith(
        normalUserId,
      );
      expect(result.count).toBe(2);

      // Verify unauthenticated attempt with only spoof header is rejected
      const unauthReq = {
        headers: { 'x-user-id': spoofedUserId },
      };
      await expect(
        controller.listUserDictionary(unauthReq as any),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        controller.learnUserWord({ word: 'foo' } as any, unauthReq as any),
      ).rejects.toThrow(UnauthorizedException);
      await expect(
        controller.unlearnUserWord('foo', unauthReq as any),
      ).rejects.toThrow(UnauthorizedException);
    });
  });
});
