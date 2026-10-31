import { BadRequestException } from '@nestjs/common';
import {
  IngestionSubmissionEnvelope,
  SubmissionPayload,
  IdentifierType,
  RecordFormat,
  SubmissionKind,
} from '@/modules/library/ingestion/types/ingestion.types';
import { IngestionCommand } from '@/modules/library/ingestion/types/ingestion.types';
import { IngestionSubmissionDto } from '@/modules/library/ingestion/dto/submission.dto';
import { UnifiedIngestionDto } from '@/modules/library/ingestion/dto/ingestion.dto';

type SubmissionPayloadBuilder = (dto: IngestionSubmissionDto) => SubmissionPayload;

const SUBMISSION_DTO_PAYLOAD_STRATEGIES: Readonly<
  Record<SubmissionKind, SubmissionPayloadBuilder>
> = {
  IDENTIFIER: (dto) => ({
    kind: 'IDENTIFIER',
    identifierType: (
      dto.identifierType || 'DOI'
    ).toUpperCase() as IdentifierType,
    value: (dto.value || dto.identifierValue || '').trim(),
  }),
  RECORD: (dto) => ({
    kind: 'RECORD',
    format: (
      dto.format ||
      dto.recordFormat ||
      'BIBTEX'
    ).toUpperCase() as RecordFormat,
    content: dto.content || dto.rawRecord || '',
  }),
  URL: (dto) => ({
    kind: 'URL',
    url: dto.url || '',
    previewToken: dto.previewToken,
    filename: dto.filename,
  }),
  FILE: (dto) => ({
    kind: 'FILE',
    fileId: dto.fileId || '',
    filename: dto.filename,
  }),
  CONNECTOR: (dto) => ({
    kind: 'CONNECTOR',
    connectionId: dto.connectionId || '',
    externalObjectId: dto.externalObjectId || '',
    externalVersion: dto.externalVersion || '',
  }),
};

interface UnifiedCommandContext {
  dto: UnifiedIngestionDto;
  userId: string;
  projectId?: string;
  collectionId?: string;
  idempotencyKey?: string;
}

type UnifiedCommandBuilder = (ctx: UnifiedCommandContext) => IngestionCommand;

const UNIFIED_SOURCE_COMMAND_STRATEGIES: Readonly<
  Record<string, UnifiedCommandBuilder>
> = {
  doi: ({ dto, userId, projectId, collectionId, idempotencyKey }) => ({
    source: 'doi',
    projectId,
    userId,
    doi: dto.doi || '',
    collectionId,
    overrides: dto.overrides,
    idempotencyKey,
  }),
  arxiv: ({ dto, userId, projectId, collectionId, idempotencyKey }) => ({
    source: 'arxiv',
    projectId,
    userId,
    arxivId: dto.arxivId || '',
    collectionId,
    overrides: dto.overrides,
    idempotencyKey,
  }),
  pmid: ({ dto, userId, projectId, collectionId, idempotencyKey }) => ({
    source: 'pmid',
    projectId,
    userId,
    pmid: dto.pmid || '',
    collectionId,
    overrides: dto.overrides,
    idempotencyKey,
  }),
  isbn: ({ dto, userId, projectId, collectionId, idempotencyKey }) => ({
    source: 'isbn',
    projectId,
    userId,
    isbn: dto.isbn || '',
    collectionId,
    overrides: dto.overrides,
    idempotencyKey,
  }),
  url: ({ dto, userId, projectId, collectionId, idempotencyKey }) => ({
    source: 'url',
    projectId,
    userId,
    url: dto.url || '',
    previewToken: dto.previewToken,
    overrides: dto.overrides,
    collectionId,
    idempotencyKey,
  }),
  bibtex: ({ dto, userId, projectId, collectionId, idempotencyKey }) => ({
    source: 'bibtex',
    projectId,
    userId,
    content: dto.content || dto.bibtex || '',
    collectionId,
    overrides: dto.overrides,
    idempotencyKey,
  }),
  ris: ({ dto, userId, projectId, collectionId, idempotencyKey }) => ({
    source: 'ris',
    projectId,
    userId,
    content: dto.content || dto.ris || '',
    collectionId,
    overrides: dto.overrides,
    idempotencyKey,
  }),
  csl_json: ({ dto, userId, projectId, collectionId, idempotencyKey }) => ({
    source: 'csl_json',
    projectId,
    userId,
    content: dto.content || '',
    collectionId,
    overrides: dto.overrides,
    idempotencyKey,
  }),
  endnote_xml: ({ dto, userId, projectId, collectionId, idempotencyKey }) => ({
    source: 'endnote_xml',
    projectId,
    userId,
    content: dto.content || '',
    collectionId,
    overrides: dto.overrides,
    idempotencyKey,
  }),
  mods: ({ dto, userId, projectId, collectionId, idempotencyKey }) => ({
    source: 'mods',
    projectId,
    userId,
    content: dto.content || '',
    collectionId,
    overrides: dto.overrides,
    idempotencyKey,
  }),
  zotero_rdf: ({ dto, userId, projectId, collectionId, idempotencyKey }) => ({
    source: 'zotero_rdf',
    projectId,
    userId,
    content: dto.content || '',
    collectionId,
    overrides: dto.overrides,
    idempotencyKey,
  }),
  medline: ({ dto, userId, projectId, collectionId, idempotencyKey }) => ({
    source: 'medline',
    projectId,
    userId,
    content: dto.content || '',
    collectionId,
    overrides: dto.overrides,
    idempotencyKey,
  }),
  csv: ({ dto, userId, projectId, collectionId, idempotencyKey }) => ({
    source: 'csv',
    projectId,
    userId,
    content: dto.content || '',
    collectionId,
    overrides: dto.overrides,
    idempotencyKey,
  }),
  pdf: ({ dto, userId, projectId, collectionId, idempotencyKey }) => ({
    source: 'pdf',
    projectId,
    userId,
    fileId: dto.fileId,
    filename: dto.filename,
    collectionId,
    overrides: dto.overrides,
    idempotencyKey,
  }),
  zotero: ({ dto, userId, projectId, collectionId, idempotencyKey }) => ({
    source: 'zotero',
    projectId,
    userId,
    connectionId: dto.connectionId,
    externalItemKey: dto.externalItemKey,
    collectionId,
    overrides: dto.overrides,
    idempotencyKey,
  }),
};

type CommandPayloadBuilder = (command: IngestionCommand) => SubmissionPayload;

function extractCommandString(
  command: IngestionCommand,
  key: string,
): string {
  const rec = command as Record<string, unknown>;
  const val = rec[key];
  return typeof val === 'string' ? val : '';
}

function createIdentifierPayloadBuilder(
  identifierType: IdentifierType,
  fieldKey: string,
): CommandPayloadBuilder {
  return (command) => ({
    kind: 'IDENTIFIER',
    identifierType,
    value: extractCommandString(command, fieldKey),
  });
}

function createRecordPayloadBuilder(format: RecordFormat): CommandPayloadBuilder {
  return (command) => ({
    kind: 'RECORD',
    format,
    content: extractCommandString(command, 'content'),
  });
}

const COMMAND_PAYLOAD_STRATEGIES: Readonly<
  Record<string, CommandPayloadBuilder>
> = {
  doi: createIdentifierPayloadBuilder('DOI', 'doi'),
  arxiv: createIdentifierPayloadBuilder('ARXIV', 'arxivId'),
  pmid: createIdentifierPayloadBuilder('PMID', 'pmid'),
  isbn: createIdentifierPayloadBuilder('ISBN', 'isbn'),
  url: (command) => ({
    kind: 'URL',
    url: extractCommandString(command, 'url'),
    previewToken:
      'previewToken' in command && typeof command.previewToken === 'string'
        ? command.previewToken
        : undefined,
  }),
  bibtex: createRecordPayloadBuilder('BIBTEX'),
  ris: createRecordPayloadBuilder('RIS'),
  csl_json: createRecordPayloadBuilder('CSL_JSON'),
  csl: createRecordPayloadBuilder('CSL_JSON'),
  json: createRecordPayloadBuilder('CSL_JSON'),
  endnote_xml: createRecordPayloadBuilder('ENDNOTE_XML'),
  mods: createRecordPayloadBuilder('MODS'),
  zotero_rdf: createRecordPayloadBuilder('ZOTERO_RDF'),
  rdf: createRecordPayloadBuilder('ZOTERO_RDF'),
  medline: createRecordPayloadBuilder('MEDLINE'),
  nbib: createRecordPayloadBuilder('MEDLINE'),
  csv: createRecordPayloadBuilder('CSV'),
  pdf: (command) => ({
    kind: 'FILE',
    fileId: extractCommandString(command, 'fileId'),
    filename:
      'filename' in command && typeof command.filename === 'string'
        ? command.filename
        : undefined,
  }),
  zotero: (command) => ({
    kind: 'CONNECTOR',
    connectionId: extractCommandString(command, 'connectionId'),
    externalObjectId: extractCommandString(command, 'externalItemKey'),
    externalVersion: '1',
  }),
  zotero_connector: (command) => ({
    kind: 'CONNECTOR',
    connectionId: extractCommandString(command, 'connectionId'),
    externalObjectId: extractCommandString(command, 'externalItemKey'),
    externalVersion: '1',
  }),
};

/**
 * Declarative Factory & Strategy Registry for translating submission DTOs,
 * unified ingestion DTOs, and IngestionCommands into canonical SubmissionEnvelopes.
 */
export class SubmissionEnvelopeFactory {
  static buildPayloadFromDto(dto: IngestionSubmissionDto): SubmissionPayload {
    const strategy = SUBMISSION_DTO_PAYLOAD_STRATEGIES[dto.kind];
    if (!strategy) {
      throw new BadRequestException(
        'Unknown ingestion kind: ' + String((dto as { kind?: unknown }).kind),
      );
    }
    return strategy(dto);
  }

  static fromSubmissionDto(params: {
    dto: IngestionSubmissionDto;
    userId: string;
    projectId?: string;
    idempotencyKey?: string;
  }): IngestionSubmissionEnvelope {
    const { dto, userId, projectId, idempotencyKey } = params;
    const payload = this.buildPayloadFromDto(dto);
    const effectiveCollectionIds =
      dto.collectionIds ?? (dto.collectionId ? [dto.collectionId] : undefined);

    return {
      projectId,
      userId,
      idempotencyKey,
      payload,
      collectionIds: effectiveCollectionIds,
      tagIds: dto.tagIds,
      overrides: dto.overrides,
      contractVersion: dto.contractVersion,
    };
  }

  static mapUnifiedDtoToCommand(params: {
    dto: UnifiedIngestionDto;
    userId: string;
    projectId?: string;
    idempotencyKey?: string;
  }): IngestionCommand {
    const { dto, userId, projectId, idempotencyKey } = params;
    const overrideObj =
      dto.overrides && typeof dto.overrides === 'object' ? dto.overrides : {};
    const effectiveCollectionId =
      dto.collectionId ||
      (typeof overrideObj.collectionId === 'string'
        ? overrideObj.collectionId
        : undefined);

    const strategy = UNIFIED_SOURCE_COMMAND_STRATEGIES[dto.source];
    if (strategy) {
      return strategy({
        dto,
        userId,
        projectId,
        collectionId: effectiveCollectionId,
        idempotencyKey,
      });
    }

    return {
      source: dto.source,
      projectId,
      userId,
      collectionId: effectiveCollectionId,
      overrides: dto.overrides,
      idempotencyKey,
    };
  }

  static fromCommand(
    projectId: string,
    command: IngestionCommand,
  ): IngestionSubmissionEnvelope {
    const sourceKey =
      typeof command.source === 'string'
        ? command.source.toLowerCase()
        : '';
    const strategy = COMMAND_PAYLOAD_STRATEGIES[sourceKey];
    if (!strategy) {
      throw new BadRequestException(
        `Unsupported ingestion source: ${String((command as { source?: unknown }).source)}`,
      );
    }

    const payload = strategy(command);

    const rawOverrides =
      'overrides' in command &&
      command.overrides &&
      typeof command.overrides === 'object'
        ? (command.overrides as Record<string, unknown>)
        : undefined;
    const overrideCollectionIds = Array.isArray(rawOverrides?.collectionIds)
      ? (rawOverrides.collectionIds as string[])
      : typeof rawOverrides?.collectionId === 'string' &&
          rawOverrides.collectionId.trim()
        ? [rawOverrides.collectionId.trim()]
        : undefined;
    const overrideTagIds = Array.isArray(rawOverrides?.tagIds)
      ? (rawOverrides.tagIds as string[])
      : undefined;

    return {
      projectId,
      userId: command.userId,
      idempotencyKey: command.idempotencyKey,
      payload,
      collectionIds: command.collectionId
        ? [command.collectionId]
        : overrideCollectionIds,
      tagIds: overrideTagIds,
      overrides: rawOverrides,
    };
  }
}
