import {
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  ArrayMaxSize,
  ArrayNotEmpty,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum SyncEntityTypeEnum {
  CatalogItem = 'CatalogItem',
  Collection = 'Collection',
  CatalogAttachment = 'CatalogAttachment',
  Note = 'Note',
  Annotation = 'Annotation',
}

export enum SyncActionEnum {
  Create = 'create',
  Update = 'update',
  Delete = 'delete',
}

export class SyncMutationDto {
  @IsEnum(SyncEntityTypeEnum)
  @IsNotEmpty()
  entityType!: SyncEntityTypeEnum;

  @IsString()
  @IsNotEmpty()
  entityId!: string;

  @IsEnum(SyncActionEnum)
  @IsNotEmpty()
  action!: SyncActionEnum;

  @IsNumber()
  @IsOptional()
  version?: number;

  @IsObject()
  @IsOptional()
  data?: Record<string, any>;
}

export class PushMutationsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SyncMutationDto)
  mutations!: SyncMutationDto[];
}

export enum SyncBatchOpTypeEnum {
  UpsertCollection = 'upsertCollection',
  UpsertCatalogItem = 'upsertCatalogItem',
  UpsertAttachment = 'upsertAttachment',
  UpsertNote = 'upsertNote',
  UpsertAnnotation = 'upsertAnnotation',
  DeleteEntity = 'deleteEntity',
}

export class ExternalSyncOperationDto {
  @IsEnum(SyncBatchOpTypeEnum)
  @IsNotEmpty()
  op!: SyncBatchOpTypeEnum;

  @IsString()
  @IsOptional()
  operationId?: string;

  @IsString()
  @IsOptional()
  parentRef?: string;

  @IsObject()
  @IsNotEmpty()
  command!: Record<string, any>;
}

export class ApplyExternalSyncBatchDto {
  @IsString()
  @IsOptional()
  idempotencyKey?: string;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ExternalSyncOperationDto)
  operations!: ExternalSyncOperationDto[];
}
