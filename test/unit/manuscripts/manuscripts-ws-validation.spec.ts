import { ValidationPipe, BadRequestException } from '@nestjs/common';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import {
  JoinProjectDto,
  JoinDocDto,
  SendUpdateDto,
  ProjectChatSendDto,
  DocSyncDto,
} from '@/modules/realtime/manuscripts/dto/events.dto';
import { YjsUpdateValidator } from '@/modules/realtime/manuscripts/yjs-update-validator';
import { WsAllExceptionsFilter } from '@/modules/realtime/core/ws-exception.filter';
import {
  RealtimeValidationFailedException,
  RealtimeAccessDeniedException,
} from '@/modules/realtime/core/ws-errors';

describe('Realtime Message Validation & Limits (US4 & RT-06 / RT-07 / RT-09 / RT-32)', () => {
  let pipe: ValidationPipe;
  let validator: YjsUpdateValidator;
  let filter: WsAllExceptionsFilter;

  beforeEach(() => {
    pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    validator = new YjsUpdateValidator();
    filter = new WsAllExceptionsFilter();
  });

  const validUUID = '01928374-beef-4000-8000-000000000001';
  const validDocUUID = '01928374-beef-4000-8000-000000000002';

  describe('1. Inbound DTO Validation (ValidationPipe)', () => {
    it('validates JoinProjectDto with UUID format and rejects non-UUID', async () => {
      await expect(
        pipe.transform({ projectId: validUUID }, { type: 'body', metatype: JoinProjectDto }),
      ).resolves.toEqual({ projectId: validUUID });

      await expect(
        pipe.transform({ projectId: 'not-a-uuid' }, { type: 'body', metatype: JoinProjectDto }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects unexpected / unwhitelisted fields (forbidNonWhitelisted)', async () => {
      await expect(
        pipe.transform(
          { projectId: validUUID, maliciousField: 'drop table' },
          { type: 'body', metatype: JoinProjectDto },
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects chat messages exceeding 4,000 characters limit', async () => {
      const normalChat = {
        projectId: validUUID,
        text: 'A'.repeat(4000),
      };
      await expect(
        pipe.transform(normalChat, { type: 'body', metatype: ProjectChatSendDto }),
      ).resolves.toBeDefined();

      const oversizeChat = {
        projectId: validUUID,
        text: 'A'.repeat(4001),
      };
      await expect(
        pipe.transform(oversizeChat, { type: 'body', metatype: ProjectChatSendDto }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects line updates with lines exceeding 2,000 array cap or debounceMs > 10,000', async () => {
      const validUpdate = {
        projectId: validUUID,
        docId: validDocUUID,
        clientRev: 1,
        lines: ['Hello world'],
        debounceMs: 500,
      };
      await expect(
        pipe.transform(validUpdate, { type: 'body', metatype: SendUpdateDto }),
      ).resolves.toBeDefined();

      const tooManyLines = {
        projectId: validUUID,
        docId: validDocUUID,
        clientRev: 1,
        lines: new Array(2001).fill('line'),
      };
      await expect(
        pipe.transform(tooManyLines, { type: 'body', metatype: SendUpdateDto }),
      ).rejects.toThrow(BadRequestException);

      const highDebounce = {
        projectId: validUUID,
        docId: validDocUUID,
        clientRev: 1,
        debounceMs: 15000,
      };
      await expect(
        pipe.transform(highDebounce, { type: 'body', metatype: SendUpdateDto }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('2. YjsUpdateValidator (Binary Verification & Size Caps)', () => {
    it('accepts Uint8Array and Buffer binary payloads', () => {
      const encoder = encoding.createEncoder();
      syncProtocol.writeSyncStep1(encoder, new Y.Doc());
      const bytes = encoding.toUint8Array(encoder);

      const validBytes = validator.validateSyncPayload(bytes, 512 * 1024);
      expect(validBytes).toBeInstanceOf(Uint8Array);

      const validBuffer = validator.validateSyncPayload(Buffer.from(bytes), 512 * 1024);
      expect(validBuffer).toBeInstanceOf(Uint8Array);
    });

    it('strictly rejects non-binary payloads (base64 string, number array, plain object)', () => {
      expect(() => validator.validateSyncPayload('base64string==', 512 * 1024)).toThrow(
        RealtimeValidationFailedException,
      );
      expect(() => validator.validateSyncPayload([1, 2, 3], 512 * 1024)).toThrow(
        RealtimeValidationFailedException,
      );
      expect(() => validator.validateSyncPayload({ data: [1, 2] }, 512 * 1024)).toThrow(
        RealtimeValidationFailedException,
      );
    });

    it('rejects binary payloads exceeding 512 KiB cap (RT-09 / SC-004)', () => {
      const oversizePayload = new Uint8Array(512 * 1024 + 1);
      expect(() => validator.validateSyncPayload(oversizePayload, 512 * 1024)).toThrow(
        RealtimeValidationFailedException,
      );
    });

    it('rejects post-apply document if size exceeds maximum allowed bytes', () => {
      const doc = new Y.Doc();
      const text = doc.getText('content');
      text.insert(0, 'Small text');

      // Small doc should pass
      expect(() => validator.validatePostApplySize(doc, 1024 * 1024)).not.toThrow();

      // Limit smaller than doc size should throw
      expect(() => validator.validatePostApplySize(doc, 5)).toThrow(
        RealtimeValidationFailedException,
      );
    });
  });

  describe('3. WsAllExceptionsFilter Standard Error Contract', () => {
    it('formats BadRequestException (validation errors) into standard generic VALIDATION_FAILED payload', () => {
      const emittedEvents: Array<{ event: string; payload: any }> = [];
      const mockSocket: any = {
        id: 'sock-err-1',
        emit: (event: string, payload: any) => emittedEvents.push({ event, payload }),
      };

      const mockHost: any = {
        switchToWs: () => ({
          getClient: () => mockSocket,
          getData: () => ({ secretField: 'should-not-leak' }),
        }),
      };

      filter.catch(new BadRequestException('Validation failed: projectId must be UUID'), mockHost);

      expect(emittedEvents).toHaveLength(1);
      const { event, payload } = emittedEvents[0];
      expect(event).toBe('error');
      expect(payload.success).toBe(false);
      expect(payload.code).toBe('VALIDATION_FAILED');
      expect(payload.error).toBe('Invalid message');
      // Must not leak internal message or echoed payload (RT-06 / SC-006)
      expect(payload.error).not.toContain('projectId');
      expect(payload.error).not.toContain('secretField');
    });

    it('passes through typed RealtimeException with its specific code', () => {
      const emittedEvents: Array<{ event: string; payload: any }> = [];
      const mockSocket: any = {
        id: 'sock-err-2',
        emit: (event: string, payload: any) => emittedEvents.push({ event, payload }),
      };

      const mockHost: any = {
        switchToWs: () => ({
          getClient: () => mockSocket,
          getData: () => ({}),
        }),
      };

      filter.catch(new RealtimeAccessDeniedException('Access denied'), mockHost);

      expect(emittedEvents).toHaveLength(1);
      const { payload } = emittedEvents[0];
      expect(payload.code).toBe('ACCESS_DENIED');
      expect(payload.retryable).toBe(false);
    });
  });
});
