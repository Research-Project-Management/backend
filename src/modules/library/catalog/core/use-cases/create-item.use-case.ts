import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import { ItemAggregate } from '../domain/item.aggregate';
import {
  ITEM_REPOSITORY_PORT,
  IItemRepositoryPort,
} from '../ports/item-repository.port';
import { ItemResultDto, toItemResultDto } from '../../dto/item-result.dto';
import { ZoteroSchemaValidatorService } from '../../services/zotero-schema-validator.service';
import { TypesService } from '../../services/types.service';

export interface CreateItemCommand {
  userId: string;
  projectId?: string | null;
  title: string;
  itemType: string;
  doi?: string | null;
  citationKey?: string | null;
  abstract?: string | null;
  year?: number | null;
  publicationTitle?: string | null;
  fields?: Record<string, any>;
  idempotencyKey?: string;
  correlationId?: string;
}

@Injectable()
export class CreateItemUseCase {
  private readonly logger = new Logger(CreateItemUseCase.name);
  private readonly validator: ZoteroSchemaValidatorService;

  constructor(
    @Inject(ITEM_REPOSITORY_PORT)
    private readonly itemRepo: IItemRepositoryPort,
    @Optional()
    validator?: ZoteroSchemaValidatorService,
  ) {
    this.validator =
      validator ?? new ZoteroSchemaValidatorService(new TypesService());
  }

  async execute(command: CreateItemCommand): Promise<ItemResultDto> {
    this.logger.debug(`Executing CreateItemUseCase for user ${command.userId}`);

    const itemType = command.itemType || 'journalArticle';
    const rawPayload: Record<string, any> = {
      ...(command.fields ?? {}),
      title: command.title,
      itemType,
      doi: command.doi,
      citationKey: command.citationKey,
      abstract: command.abstract,
      year: command.year,
      publicationTitle: command.publicationTitle,
    };

    const validation = this.validator.validateAndSanitizeItem(
      itemType,
      rawPayload,
    );
    const sanitized = validation.sanitizedItem;

    const {
      title,
      doi,
      citationKey,
      abstract,
      year,
      publicationTitle,
      itemType: validatedType,
      type: _type,
      ...remainingFields
    } = sanitized;

    // 1. Create Domain Aggregate (enforces domain rules & invariants)
    const aggregate = ItemAggregate.create({
      userId: command.userId,
      projectId: command.projectId,
      title: (title as string) || command.title || 'Untitled',
      itemType: (validatedType as string) || itemType,
      doi: (doi as string | undefined) ?? command.doi ?? null,
      citationKey:
        (citationKey as string | undefined) ?? command.citationKey ?? null,
      abstract: (abstract as string | undefined) ?? command.abstract ?? null,
      year: typeof year === 'number' ? year : (command.year ?? null),
      publicationTitle:
        (publicationTitle as string | undefined) ??
        command.publicationTitle ??
        null,
      fields: remainingFields,
    });

    // 2. Persist aggregate via domain repository port
    await this.itemRepo.save(aggregate, {
      idempotencyKey: command.idempotencyKey,
      correlationId: command.correlationId,
    });

    // 3. Return application result DTO
    return toItemResultDto(aggregate);
  }
}
