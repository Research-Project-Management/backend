import { Expose, Transform, Type } from 'class-transformer';
import {
  Allow,
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export function NormalizeNull(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) =>
    value === null ? undefined : value,
  );
}

export function FromSnake(snakeKey: string): PropertyDecorator {
  const expose = Expose();
  const transform = Transform(
    ({ value, obj }: { value: unknown; obj: unknown }) => {
      const record =
        obj && typeof obj === 'object'
          ? (obj as Record<string, unknown>)
          : undefined;
      const resolved =
        value !== undefined && value !== null ? value : record?.[snakeKey];
      return resolved === null ? undefined : resolved;
    },
  );
  return (target, propertyKey) => {
    expose(target, propertyKey);
    transform(target, propertyKey);
  };
}

export class QueryMessageDto {
  @IsIn(['user', 'assistant', 'system'])
  role!: 'user' | 'assistant' | 'system';

  @IsString()
  content!: string;

  @IsOptional()
  @Allow()
  attachments?: unknown;

  @IsOptional()
  @Allow()
  sources?: unknown;
}

export class QueryDto {
  @NormalizeNull()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QueryMessageDto)
  @IsOptional()
  messages?: QueryMessageDto[];

  @NormalizeNull()
  @IsString()
  @IsOptional()
  query?: string;

  @FromSnake('space_id')
  @IsString()
  @IsOptional()
  spaceId?: string;

  @FromSnake('chat_id')
  @IsString()
  @IsOptional()
  chatId?: string;

  @FromSnake('page_id')
  @IsString()
  @IsOptional()
  pageId?: string;

  @FromSnake('document_ids')
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  documentIds?: string[];

  @FromSnake('web_search_sites')
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  webSearchSites?: string[];

  @NormalizeNull()
  @IsString()
  @IsOptional()
  filename?: string;

  @FromSnake('active_file_id')
  @IsString()
  @IsOptional()
  activeFileId?: string;

  @FromSnake('active_file_path')
  @IsString()
  @IsOptional()
  activeFilePath?: string;

  @FromSnake('file_content')
  @IsString()
  @IsOptional()
  fileContent?: string;

  @NormalizeNull()
  @IsString()
  @IsOptional()
  selection?: string;

  @FromSnake('cursor_context')
  @IsString()
  @IsOptional()
  cursorContext?: string;

  @FromSnake('cursor_line')
  @IsNumber()
  @IsOptional()
  cursorLine?: number;

  @FromSnake('cursor_column')
  @IsNumber()
  @IsOptional()
  cursorColumn?: number;

  @FromSnake('selection_start_line')
  @IsNumber()
  @IsOptional()
  selectionStartLine?: number;

  @FromSnake('selection_end_line')
  @IsNumber()
  @IsOptional()
  selectionEndLine?: number;

  @FromSnake('selection_start_column')
  @IsNumber()
  @IsOptional()
  selectionStartColumn?: number;

  @FromSnake('selection_end_column')
  @IsNumber()
  @IsOptional()
  selectionEndColumn?: number;

  @FromSnake('document_structure')
  @IsOptional()
  @Allow()
  documentStructure?: string | Record<string, unknown>[];

  @FromSnake('context_before')
  @IsString()
  @IsOptional()
  contextBefore?: string;

  @FromSnake('context_after')
  @IsString()
  @IsOptional()
  contextAfter?: string;

  @FromSnake('current_section')
  @IsString()
  @IsOptional()
  currentSection?: string;

  @FromSnake('current_environment')
  @IsString()
  @IsOptional()
  currentEnvironment?: string;

  @FromSnake('document_structure_summary')
  @IsString()
  @IsOptional()
  documentStructureSummary?: string;

  @FromSnake('user_selection')
  @IsOptional()
  @Allow()
  userSelection?: string | Record<string, unknown>;

  @FromSnake('compile_errors')
  @IsOptional()
  @Allow()
  compileErrors?: unknown;

  @FromSnake('use_rag')
  @IsBoolean()
  @IsOptional()
  useRag?: boolean;

  @FromSnake('intent_hint')
  @IsString()
  @IsOptional()
  intentHint?: string;

  @NormalizeNull()
  @IsOptional()
  @Allow()
  context?: Record<string, unknown>;
}

export class ResumeDto {
  @IsOptional()
  @Allow()
  decision: unknown;

  @FromSnake('space_id')
  @IsString()
  @IsOptional()
  spaceId?: string;

  @FromSnake('chat_id')
  @IsString()
  @IsNotEmpty()
  chatId!: string;

  @FromSnake('page_id')
  @IsString()
  @IsOptional()
  pageId?: string;

  @FromSnake('document_ids')
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  documentIds?: string[];
}
