import {
  ArgumentsHost,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { GlobalExceptionFilter } from '@/core/http/filters/exception.filter';
import {
  DistributedLockTimeoutError,
  PagesDomainError,
  PagesServiceUnavailableError,
  SsrfSecurityException,
} from '@/modules/pages/core';
import {
  CannotDeleteRootFolderError,
  CyclicMoveError,
  DuplicateNodePathError,
  InvalidNodeNameError,
  MaxProjectFilesExceededError,
  NodeNotFoundError,
  RootDocNotFoundError,
  StructureError,
} from '@/modules/pages/structure/domain/structure.errors';
import {
  ArchiveObjectNotFoundError,
  ArchiveWriteFailedError,
  DocModifiedError,
  DocNotFoundError,
  DocTooLargeError,
  InvalidSearchPatternError,
  Md5MismatchError,
  NullByteDetectedError,
} from '@/modules/pages/docstore/domain/doc.errors';
import { assertExpectedVersionAndRev } from '@/modules/pages/docstore/services/doc-occ.helper';
import type { DocstoreService } from '@/modules/pages/docstore/docstore.service';
import {
  DuplicateFileException,
  FileNotFoundException,
  FilestoreValidationException,
  InvalidByteRangeException,
  StorageQuotaExceededException,
} from '@/modules/pages/filestore/filestore.types';
import {
  ClsiQueueUnavailableError,
  ClsiWorkerExecutionError,
  RemoteClsiClientError,
  SandboxConfigurationException,
  SandboxPolicyViolationException,
  SandboxUnavailableException,
  UnsafePathException,
} from '@/modules/pages/clsi/domain/sandbox.errors';
import {
  AlreadyCompilingError,
  AutoCompileShedError,
  CompileAbortedError,
  CompileRateLimitExceededError,
  CompileSupersededError,
  TooManyCompileRequestsError,
} from '@/modules/pages/clsi/domain/compile-lock.errors';
import {
  ProjectLockAbortedError,
  ProjectLockTimeoutError,
} from '@/modules/pages/clsi/adapters/workspace-fs.adapters';
import {
  ExplanationNotFoundException,
  InvalidLogFormatException,
} from '@/modules/pages/diagnostics/domain/diagnostics.errors';
import {
  IdentifierNotFoundException,
  InvalidBibtexException,
} from '@/modules/pages/citations/domain/citations.errors';
import {
  InvalidWordException,
  UnsupportedLanguageException,
} from '@/modules/pages/spelling/domain/spelling.errors';
import {
  InvalidTemplateException,
  TemplateNotFoundException,
} from '@/modules/pages/templates/domain/templates.errors';
import {
  ArchiveFileLimitExceededException,
  ArchiveSizeExceededException,
  InvalidZipArchiveException,
  ZipSlipSecurityException,
} from '@/modules/pages/export-import/domain/archive-validator';
import { GitBridgeDomainError } from '@/modules/pages/git-bridge/domain/git-bridge.types';
import {
  DuplicateLabelException,
  EmptyProjectException,
  SnapshotFileNotFoundException,
  VersionNotFoundException,
} from '@/modules/pages/history/domain/errors';
import { InvalidVersionLabelException } from '@/modules/pages/history/domain/label.entity';
import {
  ChangeNotFoundError,
  InvalidChangeError,
  InvalidReplyError,
  InvalidThreadError,
  PatchConflictError,
  ResolvedThreadError,
  StaleAnchorError,
  ThreadNotFoundError,
} from '@/modules/pages/review/domain/review.errors';
import { PagesFacade } from '@/modules/pages/pages.facade';
import {
  WsAllExceptionsFilter,
  RealtimeRateLimitedException,
  RealtimeValidationFailedException,
} from '@/modules/realtime/core/errors';

interface CapturedHttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: {
    success: boolean;
    error: {
      code: string;
      message: string;
      details?: unknown;
    };
    statusCode: number;
    timestamp: string;
    path: string;
    requestId?: string;
  };
}

interface MockHttpReply {
  header: jest.Mock<MockHttpReply, [string, string]>;
  setHeader: jest.Mock<MockHttpReply, [string, string]>;
  status: jest.Mock<MockHttpReply, [number]>;
  code: jest.Mock<MockHttpReply, [number]>;
  send: jest.Mock<MockHttpReply, [CapturedHttpResponse['body']]>;
  json: jest.Mock<MockHttpReply, [CapturedHttpResponse['body']]>;
}

function createHttpHostMock(): {
  host: ArgumentsHost;
  getResult: () => CapturedHttpResponse;
} {
  let capturedStatus = 0;
  let capturedBody: CapturedHttpResponse['body'] | undefined;
  const headers: Record<string, string> = {};

  const reply: MockHttpReply = {
    header: jest.fn((name: string, value: string): MockHttpReply => {
      headers[name.toLowerCase()] = value;
      return reply;
    }),
    setHeader: jest.fn((name: string, value: string): MockHttpReply => {
      headers[name.toLowerCase()] = value;
      return reply;
    }),
    status: jest.fn((code: number): MockHttpReply => {
      capturedStatus = code;
      return reply;
    }),
    code: jest.fn((code: number): MockHttpReply => {
      capturedStatus = code;
      return reply;
    }),
    send: jest.fn((body: CapturedHttpResponse['body']): MockHttpReply => {
      capturedBody = body;
      return reply;
    }),
    json: jest.fn((body: CapturedHttpResponse['body']): MockHttpReply => {
      capturedBody = body;
      return reply;
    }),
  };

  const request = {
    url: '/api/v1/pages/compile',
    method: 'POST',
    id: 'req-pages-flow-001',
    headers: { 'x-request-id': 'req-pages-flow-001' },
  };

  const host = {
    switchToHttp: () => ({
      getResponse: () => reply,
      getRequest: () => request,
    }),
  } as unknown as ArgumentsHost;

  return {
    host,
    getResult: () => {
      if (!capturedBody) {
        throw new Error(
          'Expected GlobalExceptionFilter to write response body',
        );
      }
      return { statusCode: capturedStatus, headers, body: capturedBody };
    },
  };
}

function createWsHostMock(): {
  host: ArgumentsHost;
  emitMock: jest.Mock;
} {
  const emitMock = jest.fn();
  const client = { id: 'ws-client-001', emit: emitMock };

  const host = {
    switchToWs: () => ({
      getClient: () => client,
      getData: () => ({}),
      getPattern: () => 'yjs:sync',
    }),
  } as unknown as ArgumentsHost;

  return { host, emitMock };
}

describe('Backend Pages Error Architecture & Flow Verification', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  describe('1. PagesDomainError Contract Across All Bounded Subdomains', () => {
    const cases: Array<[string, PagesDomainError, number, string]> = [
      // Core
      [
        'PagesServiceUnavailableError',
        new PagesServiceUnavailableError(
          'EditorBootstrapService is not available',
        ),
        503,
        'PAGES_SERVICE_UNAVAILABLE',
      ],
      [
        'DistributedLockTimeoutError',
        new DistributedLockTimeoutError('doc:lock:1', 5000),
        409,
        'DISTRIBUTED_LOCK_TIMEOUT',
      ],
      [
        'SsrfSecurityException',
        new SsrfSecurityException('Private IP blocked'),
        403,
        'SSRF_SECURITY_VIOLATION',
      ],
      // Structure
      [
        'StructureError',
        new StructureError('Invalid op'),
        400,
        'STRUCTURE_ERROR',
      ],
      [
        'NodeNotFoundError',
        new NodeNotFoundError('node-1'),
        404,
        'STRUCTURE_NODE_NOT_FOUND',
      ],
      [
        'DuplicateNodePathError',
        new DuplicateNodePathError('/main.tex'),
        409,
        'STRUCTURE_DUPLICATE_NODE_PATH',
      ],
      [
        'CyclicMoveError',
        new CyclicMoveError('/a', '/a/b'),
        400,
        'STRUCTURE_CYCLIC_MOVE',
      ],
      [
        'InvalidNodeNameError',
        new InvalidNodeNameError('bad/name'),
        400,
        'STRUCTURE_INVALID_NODE_NAME',
      ],
      [
        'CannotDeleteRootFolderError',
        new CannotDeleteRootFolderError(),
        400,
        'STRUCTURE_CANNOT_DELETE_ROOT',
      ],
      [
        'RootDocNotFoundError',
        new RootDocNotFoundError('space-1'),
        404,
        'STRUCTURE_ROOT_DOC_NOT_FOUND',
      ],
      [
        'MaxProjectFilesExceededError',
        new MaxProjectFilesExceededError(2000),
        400,
        'STRUCTURE_MAX_PROJECT_FILES_EXCEEDED',
      ],
      // Docstore
      ['DocNotFoundError', new DocNotFoundError(), 404, 'DOC_NOT_FOUND'],
      ['DocModifiedError', new DocModifiedError(), 409, 'DOC_VERSION_CONFLICT'],
      [
        'DocTooLargeError',
        new DocTooLargeError(1024, 512),
        413,
        'DOC_TOO_LARGE',
      ],
      [
        'NullByteDetectedError',
        new NullByteDetectedError(),
        400,
        'INVALID_DOC_CONTENT',
      ],
      ['Md5MismatchError', new Md5MismatchError(), 400, 'MD5_MISMATCH'],
      [
        'InvalidSearchPatternError',
        new InvalidSearchPatternError('Invalid regex'),
        400,
        'INVALID_SEARCH_PATTERN',
      ],
      [
        'ArchiveObjectNotFoundError',
        new ArchiveObjectNotFoundError('docs/a.tex'),
        404,
        'ARCHIVE_OBJECT_NOT_FOUND',
      ],
      [
        'ArchiveWriteFailedError',
        new ArchiveWriteFailedError('docs/a.tex', 'EIO disk error'),
        503,
        'ARCHIVE_WRITE_FAILED',
      ],
      // Filestore
      [
        'FileNotFoundException',
        new FileNotFoundException('file-1', 'space-1'),
        404,
        'FILE_NOT_FOUND',
      ],
      [
        'InvalidByteRangeException',
        new InvalidByteRangeException('bytes=500-900', 100),
        416,
        'INVALID_BYTE_RANGE',
      ],
      [
        'DuplicateFileException',
        new DuplicateFileException('fig.png', 'space-1'),
        409,
        'DUPLICATE_FILE',
      ],
      [
        'StorageQuotaExceededException',
        new StorageQuotaExceededException(2000, 1000),
        413,
        'STORAGE_QUOTA_EXCEEDED',
      ],
      [
        'FilestoreValidationException',
        new FilestoreValidationException('Bad hash'),
        400,
        'FILESTORE_VALIDATION_ERROR',
      ],
      // CLSI
      [
        'SandboxUnavailableException',
        new SandboxUnavailableException(
          'Compilation is temporarily unavailable.',
          '/var/run/docker.sock',
        ),
        503,
        'SANDBOX_UNAVAILABLE',
      ],
      [
        'SandboxConfigurationException',
        new SandboxConfigurationException(
          'CLSI Sandbox configuration is invalid.',
          'BAD_UID',
        ),
        500,
        'SANDBOX_CONFIG_INVALID',
      ],
      [
        'SandboxPolicyViolationException',
        new SandboxPolicyViolationException(
          'Compilation could not be started.',
          'seccomp',
        ),
        500,
        'SANDBOX_POLICY_VIOLATION',
      ],
      [
        'UnsafePathException',
        new UnsafePathException('Invalid file path.', '../secret'),
        400,
        'UNSAFE_PATH',
      ],
      [
        'ClsiQueueUnavailableError',
        new ClsiQueueUnavailableError(),
        503,
        'CLSI_QUEUE_UNAVAILABLE',
      ],
      [
        'AlreadyCompilingError',
        new AlreadyCompilingError(),
        423,
        'COMPILE_IN_PROGRESS',
      ],
      [
        'TooManyCompileRequestsError',
        new TooManyCompileRequestsError(),
        503,
        'TOO_MANY_COMPILE_REQUESTS',
      ],
      [
        'CompileAbortedError',
        new CompileAbortedError(),
        499,
        'COMPILE_ABORTED',
      ],
      [
        'CompileRateLimitExceededError',
        new CompileRateLimitExceededError(20),
        429,
        'COMPILE_RATE_LIMITED',
      ],
      [
        'AutoCompileShedError',
        new AutoCompileShedError(42, 40),
        429,
        'AUTO_COMPILE_SHED',
      ],
      [
        'CompileSupersededError',
        new CompileSupersededError(),
        409,
        'COMPILE_SUPERSEDED',
      ],
      [
        'ClsiWorkerExecutionError',
        new ClsiWorkerExecutionError('Worker crashed'),
        503,
        'CLSI_WORKER_FAILED',
      ],
      [
        'RemoteClsiClientError',
        new RemoteClsiClientError('Queue full', 503, 'COMPILE_QUEUE_FULL'),
        503,
        'COMPILE_QUEUE_FULL',
      ],
      [
        'ProjectLockTimeoutError',
        new ProjectLockTimeoutError('space-1', 30000),
        409,
        'PROJECT_LOCK_TIMEOUT',
      ],
      [
        'ProjectLockAbortedError',
        new ProjectLockAbortedError('space-1'),
        499,
        'PROJECT_LOCK_ABORTED',
      ],
      // Diagnostics
      [
        'ExplanationNotFoundException',
        new ExplanationNotFoundException('E100'),
        404,
        'DIAGNOSTIC_EXPLANATION_NOT_FOUND',
      ],
      [
        'InvalidLogFormatException',
        new InvalidLogFormatException(),
        400,
        'INVALID_COMPILE_LOG',
      ],
      // Citations
      [
        'IdentifierNotFoundException',
        new IdentifierNotFoundException('10.1000/404'),
        404,
        'CITATION_IDENTIFIER_NOT_FOUND',
      ],
      [
        'InvalidBibtexException',
        new InvalidBibtexException(),
        400,
        'INVALID_BIBTEX',
      ],
      // Spelling
      [
        'InvalidWordException',
        new InvalidWordException('123'),
        400,
        'INVALID_SPELLING_WORD',
      ],
      [
        'UnsupportedLanguageException',
        new UnsupportedLanguageException('zz'),
        400,
        'UNSUPPORTED_SPELLING_LANGUAGE',
      ],
      // Templates
      [
        'InvalidTemplateException',
        new InvalidTemplateException('No main'),
        400,
        'INVALID_TEMPLATE',
      ],
      [
        'TemplateNotFoundException',
        new TemplateNotFoundException('unknown-tpl'),
        404,
        'TEMPLATE_NOT_FOUND',
      ],
      // Export-Import
      [
        'ZipSlipSecurityException',
        new ZipSlipSecurityException('../evil.tex'),
        403,
        'ZIP_SLIP_DETECTED',
      ],
      [
        'ArchiveFileLimitExceededException',
        new ArchiveFileLimitExceededException(2000),
        400,
        'ARCHIVE_FILE_LIMIT_EXCEEDED',
      ],
      [
        'InvalidZipArchiveException',
        new InvalidZipArchiveException(),
        400,
        'INVALID_ZIP_ARCHIVE',
      ],
      [
        'ArchiveSizeExceededException',
        new ArchiveSizeExceededException(100_000_000, 50_000_000),
        413,
        'ARCHIVE_SIZE_EXCEEDED',
      ],
      // Git Bridge
      [
        'GitBridgeDomainError',
        new GitBridgeDomainError('Bad ref'),
        400,
        'GIT_BRIDGE_ERROR',
      ],
      // Project History
      [
        'DuplicateLabelException',
        new DuplicateLabelException('space-1', 'v1.0'),
        409,
        'DUPLICATE_VERSION_LABEL',
      ],
      [
        'EmptyProjectException',
        new EmptyProjectException('space-1'),
        400,
        'EMPTY_PAGE_SNAPSHOT',
      ],
      [
        'VersionNotFoundException',
        new VersionNotFoundException('space-1', 2),
        404,
        'VERSION_NOT_FOUND',
      ],
      [
        'SnapshotFileNotFoundException',
        new SnapshotFileNotFoundException('/main.tex', 2),
        404,
        'SNAPSHOT_FILE_NOT_FOUND',
      ],
      [
        'InvalidVersionLabelException',
        new InvalidVersionLabelException(),
        400,
        'INVALID_VERSION_LABEL',
      ],
      // Track Changes & Review
      [
        'ChangeNotFoundError',
        new ChangeNotFoundError('chg-1'),
        404,
        'TRACK_CHANGE_NOT_FOUND',
      ],
      [
        'StaleAnchorError',
        new StaleAnchorError('chg-1'),
        409,
        'STALE_TRACK_CHANGE_ANCHOR',
      ],
      [
        'ResolvedThreadError',
        new ResolvedThreadError('thr-1'),
        409,
        'COMMENT_THREAD_RESOLVED',
      ],
      [
        'ThreadNotFoundError',
        new ThreadNotFoundError('thr-1'),
        404,
        'COMMENT_THREAD_NOT_FOUND',
      ],
      [
        'PatchConflictError',
        new PatchConflictError('doc-1'),
        409,
        'TRACK_CHANGE_PATCH_CONFLICT',
      ],
      [
        'InvalidReplyError',
        new InvalidReplyError(),
        400,
        'INVALID_COMMENT_REPLY',
      ],
      [
        'InvalidThreadError',
        new InvalidThreadError('Invalid range'),
        400,
        'INVALID_COMMENT_THREAD',
      ],
      [
        'InvalidChangeError',
        new InvalidChangeError('Invalid change'),
        400,
        'INVALID_TRACK_CHANGE',
      ],
    ];

    it.each(
      cases.map(
        ([label, err, expectedStatus, expectedCode]) =>
          [label, expectedStatus, expectedCode, err] as const,
      ),
    )(
      '%s extends PagesDomainError with statusCode=%i and SNAKE_CASE code=%s',
      (_label, expectedStatus, expectedCode, err) => {
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(PagesDomainError);
        expect(err.statusCode).toBe(expectedStatus);
        expect(err.httpStatus).toBe(expectedStatus);
        expect(err.code).toBe(expectedCode);
        expect(err.code).toMatch(/^[A-Z0-9_]+$/);
        expect(err.message.length).toBeGreaterThan(0);
      },
    );

    it('PagesFacade throws typed PagesServiceUnavailableError when editorBootstrap is missing', async () => {
      const facade = new PagesFacade(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
      );

      await expect(
        facade.bootstrapEditor({
          spaceId: 'space-1',
          userId: 'user-1',
        } as never),
      ).rejects.toBeInstanceOf(PagesServiceUnavailableError);
    });
  });

  describe('2. GlobalExceptionFilter HTTP Error Flow', () => {
    const filter = new GlobalExceptionFilter();

    it('serializes PagesDomainError subclasses into standard HTTP error envelope with x-request-id', () => {
      const scenarios: Array<[PagesDomainError, number, string]> = [
        [
          new SsrfSecurityException('Metadata IP blocked'),
          403,
          'SSRF_SECURITY_VIOLATION',
        ],
        [new CompileRateLimitExceededError(20), 429, 'COMPILE_RATE_LIMITED'],
        [new TooManyCompileRequestsError(), 503, 'TOO_MANY_COMPILE_REQUESTS'],
        [
          new ProjectLockTimeoutError('space-1', 30000),
          409,
          'PROJECT_LOCK_TIMEOUT',
        ],
        [new ClsiQueueUnavailableError(), 503, 'CLSI_QUEUE_UNAVAILABLE'],
      ];

      for (const [domainError, expectedStatus, expectedCode] of scenarios) {
        const { host, getResult } = createHttpHostMock();
        filter.catch(domainError, host);
        const res = getResult();

        expect(res.statusCode).toBe(expectedStatus);
        expect(res.headers['x-request-id']).toBe('req-pages-flow-001');
        expect(res.body.success).toBe(false);
        expect(res.body.statusCode).toBe(expectedStatus);
        expect(res.body.path).toBe('/api/v1/pages/compile');
        expect(res.body.requestId).toBe('req-pages-flow-001');
        expect(res.body.error.code).toBe(expectedCode);
        expect(res.body.error.message).toBe(domainError.message);
      }
    });

    it('does not leak SandboxUnavailableException internalReason into HTTP response body', () => {
      const secretHostReason =
        '/host/secret/docker.sock permission denied uid=1001';
      const err = new SandboxUnavailableException(
        'Compilation is temporarily unavailable.',
        secretHostReason,
      );
      const { host, getResult } = createHttpHostMock();

      filter.catch(err, host);
      const res = getResult();
      const serialized = JSON.stringify(res.body);

      expect(res.statusCode).toBe(503);
      expect(res.body.error.code).toBe('SANDBOX_UNAVAILABLE');
      expect(res.body.error.message).toBe(
        'Compilation is temporarily unavailable.',
      );
      expect(serialized).not.toContain(secretHostReason);
      expect(serialized).not.toContain('internalReason');
    });

    it('preserves OCC 409 ConflictException details (currentRev & remoteContent) through GlobalExceptionFilter', async () => {
      const mockDocstore = {
        getDoc: jest.fn().mockResolvedValue({
          id: 'doc-1',
          lines: ['\\section{Updated by Peer}'],
          rev: 7,
          version: 3,
        }),
      } as unknown as DocstoreService;

      let occError: unknown;
      try {
        await assertExpectedVersionAndRev(
          mockDocstore,
          {
            id: 'doc-1',
            spaceId: 'space-1',
            rev: 7,
            version: 3,
            inStorage: true,
            lines: [],
          },
          5,
        );
      } catch (err) {
        occError = err;
      }

      expect(occError).toBeInstanceOf(ConflictException);
      const { host, getResult } = createHttpHostMock();
      filter.catch(occError, host);
      const res = getResult();

      expect(res.statusCode).toBe(409);
      expect(res.body.error.code).toBe('DOC_VERSION_CONFLICT');
      expect(res.body.error.details).toEqual(
        expect.objectContaining({
          docId: 'doc-1',
          expectedRev: 5,
          currentRev: 7,
          currentVersion: 3,
          remoteContent: '\\section{Updated by Peer}',
        }),
      );
    });

    it('maps Prisma P2002 (409) and P2025 (404) errors cleanly', () => {
      const { host: hostConflict, getResult: getConflict } =
        createHttpHostMock();
      filter.catch(
        { code: 'P2002', message: 'Unique constraint failed' },
        hostConflict,
      );
      expect(getConflict().statusCode).toBe(409);

      const { host: hostNotFound, getResult: getNotFound } =
        createHttpHostMock();
      filter.catch(
        { code: 'P2025', message: 'Record to update not found' },
        hostNotFound,
      );
      expect(getNotFound().statusCode).toBe(404);
    });

    it('sanitizes unexpected untyped Error details in production mode', () => {
      process.env.NODE_ENV = 'production';
      const { host, getResult } = createHttpHostMock();
      const rawStackLeak = new Error(
        'SELECT * FROM secret_tokens FAILED at /srv/app.ts:42',
      );

      filter.catch(rawStackLeak, host);
      const res = getResult();
      const serialized = JSON.stringify(res.body);

      expect(res.statusCode).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_SERVER_ERROR');
      expect(serialized).not.toContain('secret_tokens');
      expect(serialized).not.toContain('/srv/app.ts');
    });
  });

  describe('3. WsAllExceptionsFilter WebSocket Error Flow', () => {
    const wsFilter = new WsAllExceptionsFilter();

    it('emits structured retryable/non-retryable error payloads for RealtimeException subclasses', () => {
      const { host: rateHost, emitMock: rateEmit } = createWsHostMock();
      wsFilter.catch(
        new RealtimeRateLimitedException('Burst limit exceeded'),
        rateHost,
      );
      expect(rateEmit).toHaveBeenCalledTimes(1);
      const [rateEvent, ratePayload] = rateEmit.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(rateEvent).toBe('error');
      expect(ratePayload.success).toBe(false);
      expect(ratePayload.code).toBe('RATE_LIMITED');
      expect(typeof ratePayload.error).toBe('string');
      expect(ratePayload.retryable).toBe(true);

      const { host: valHost, emitMock: valEmit } = createWsHostMock();
      wsFilter.catch(
        new RealtimeValidationFailedException('Malformed Yjs update frame'),
        valHost,
      );
      expect(valEmit).toHaveBeenCalledTimes(1);
      const [valEvent, valPayload] = valEmit.mock.calls[0] as [
        string,
        Record<string, unknown>,
      ];
      expect(valEvent).toBe('error');
      expect(valPayload.success).toBe(false);
      expect(valPayload.code).toBe('VALIDATION_FAILED');
      expect(typeof valPayload.error).toBe('string');
      expect(valPayload.retryable).toBe(false);
    });

    it('sanitizes BadRequestException and maps ForbiddenException & unhandled Error', () => {
      const { host: badHost, emitMock: badEmit } = createWsHostMock();
      wsFilter.catch(
        new BadRequestException(['field X must not be empty']),
        badHost,
      );
      expect(badEmit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({
          success: false,
          code: 'VALIDATION_FAILED',
          error: 'Invalid message',
          retryable: false,
        }),
      );

      const { host: forbHost, emitMock: forbEmit } = createWsHostMock();
      wsFilter.catch(
        new ForbiddenException('Project access revoked'),
        forbHost,
      );
      expect(forbEmit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({
          retryable: false,
        }),
      );

      const { host: errHost, emitMock: errEmit } = createWsHostMock();
      wsFilter.catch(new Error('Unexpected socket buffer crash'), errHost);
      expect(errEmit).toHaveBeenCalledWith(
        'error',
        expect.objectContaining({
          retryable: true,
        }),
      );
    });
  });
});
