import { Injectable, Inject, Optional, Logger } from '@nestjs/common';
import {
  ITEM_REPOSITORY_PORT,
  IItemRepositoryPort,
} from '../ports/item-repository.port';
import { ItemNotFoundDomainException } from '../domain/item-domain.exception';
import { ItemResultDto, toItemResultDto } from '../../dto/item-result.dto';
import { ZoteroSchemaValidatorService } from '../../services/zotero-schema-validator.service';
import { TypesService } from '../../services/types.service';

export interface UpdateItemCommand {
  userId: string;
  itemId: string;
  projectId?: string | null;
  expectedVersion?: number;
  changes: {
    title?: string;
    itemType?: string;
    doi?: string | null;
    citationKey?: string | null;
    abstract?: string | null;
    year?: number | null;
    publicationTitle?: string | null;
    fields?: Record<string, any>;
    [key: string]: any;
  };
  correlationId?: string;
}

@Injectable()
export class UpdateItemUseCase {
  private readonly logger = new Logger(UpdateItemUseCase.name);
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

  async execute(command: UpdateItemCommand): Promise<ItemResultDto> {
    this.logger.debug(
      `Executing UpdateItemUseCase for item ${command.itemId} (user: ${command.userId})`,
    );

    // 1. Load domain aggregate
    const aggregate = await this.itemRepo.findById(
      command.userId,
      command.itemId,
      command.projectId ?? undefined,
    );

    if (!aggregate) {
      throw new ItemNotFoundDomainException(command.itemId);
    }

    // 2. Resolve target itemType
    const targetItemType =
      command.changes.itemType ||
      command.changes.type ||
      aggregate.itemType ||
      'journalArticle';

    // 3. Validate and sanitize partial update against Zotero Schema v42
    const validation = this.validator.validateAndSanitizeItem(
      targetItemType,
      command.changes,
    );
    const sanitized = validation.sanitizedItem;

    const {
      title,
      itemType: newType,
      type: _type,
      doi,
      citationKey,
      abstract,
      year,
      publicationTitle,
      ...remainingFields
    } = sanitized;

    const aggregateChanges: Record<string, any> = {
      ...(title !== undefined ? { title } : {}),
      ...(newType !== undefined ? { itemType: newType } : {}),
      ...(doi !== undefined ? { doi } : {}),
      ...(citationKey !== undefined ? { citationKey } : {}),
      ...(abstract !== undefined ? { abstract } : {}),
      ...(year !== undefined ? { year } : {}),
      ...(publicationTitle !== undefined ? { publicationTitle } : {}),
      fields: remainingFields,
    };

    // 4. Mutate aggregate via domain methods (enforces invariants & versioning)
    aggregate.updateMetadata(aggregateChanges, command.expectedVersion);

    // 5. Persist modified aggregate
    await this.itemRepo.save(aggregate);

    // 6. Return DTO
    return toItemResultDto(aggregate);
  }
}
