/**
 * citations/core/use-cases/resolve-identifier-to-bib.use-case.ts
 * Inbound Use Case: Resolves DOI / arXiv identifier and automatically inserts BibTeX into the project.
 */

import { IIdentifierResolverPort } from '../ports/identifier-resolver.port';
import { ICitationsAggregatorPort } from '../ports/citations-aggregator.port';
import { AcademicIdentifierVo } from '../domain/value-objects/academic-identifier.vo';
import { BibEntry } from '../domain/entities/bib-entry.entity';
import { IdentifierNotFoundException } from '../domain/exceptions/identifier-not-found.exception';

export interface ResolveIdentifierToBibCommand {
  projectId: string;
  identifier: string;
  targetBibFile?: string;
}

export interface ResolveIdentifierResult {
  entry: BibEntry;
  filePath: string;
  identifierType: string;
}

export class ResolveIdentifierToBibUseCase {
  constructor(
    private readonly resolver: IIdentifierResolverPort,
    private readonly aggregator: ICitationsAggregatorPort
  ) {}

  public async execute(
    command: ResolveIdentifierToBibCommand
  ): Promise<ResolveIdentifierResult> {
    const idVo = AcademicIdentifierVo.parse(command.identifier);
    if (idVo.type === 'unknown') {
      throw new IdentifierNotFoundException(command.identifier);
    }

    const resolvedEntry = await this.resolver.resolve(idVo);
    if (!resolvedEntry) {
      throw new IdentifierNotFoundException(command.identifier);
    }

    const targetFile = command.targetBibFile || 'references.bib';
    const filePath = await this.aggregator.appendEntryToBib(
      command.projectId,
      resolvedEntry,
      targetFile
    );

    return {
      entry: resolvedEntry,
      filePath,
      identifierType: idVo.type,
    };
  }
}
