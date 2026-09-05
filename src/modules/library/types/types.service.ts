import { Injectable, Logger } from '@nestjs/common';
import {
  ItemFieldDefinition,
  CreatorTypeDefinition,
  ItemTypeDefinition,
  SchemaRegistrySnapshot,
} from './types.types';
import {
  SCHEMA_V42_DATA,
  LIBRARY_SCHEMA_VERSION,
  SCHEMA_SOURCE,
  ALL_CREATOR_ROLES,
} from './types.data';

@Injectable()
export class TypesService {
  private readonly logger = new Logger(TypesService.name);
  private readonly snapshot: SchemaRegistrySnapshot = SCHEMA_V42_DATA;

  /**
   * Return schema version and source
   */
  getVersion(): number {
    return this.snapshot.version;
  }

  getSchemaVersion(): number {
    return this.snapshot.version;
  }

  getSource(): string {
    return this.snapshot.source;
  }

  /**
   * Get complete schema registry snapshot
   */
  getSnapshot(): SchemaRegistrySnapshot {
    return this.snapshot;
  }

  /**
   * List all supported item types
   */
  getAllItemTypes(includeSpecial = false): ItemTypeDefinition[] {
    const types = Object.values(this.snapshot.itemTypes);
    if (includeSpecial) {
      return types;
    }
    return types.filter((t) => t.isBibliographic);
  }

  getItemTypes(
    options?: boolean | { bibliographicOnly?: boolean },
  ): ItemTypeDefinition[] {
    const includeSpecial =
      typeof options === 'boolean' ? options : !options?.bibliographicOnly;
    return this.getAllItemTypes(includeSpecial);
  }

  /**
   * Get specific item type definition
   */
  getItemType(itemType: string): ItemTypeDefinition | undefined {
    if (!itemType) return undefined;
    const normalized = this.normalizeTypeKey(itemType);
    return this.snapshot.itemTypes[normalized];
  }

  /**
   * Check if an itemType is valid and registered
   */
  isValidItemType(itemType: string): boolean {
    if (!itemType) return false;
    const normalized = this.normalizeTypeKey(itemType);
    return normalized in this.snapshot.itemTypes;
  }

  isValidType(itemType: string): boolean {
    return this.isValidItemType(itemType);
  }

  /**
   * Check if type is bibliographic (regular 37 types)
   */
  isBibliographic(itemType: string): boolean {
    const def = this.getItemType(itemType);
    return def?.isBibliographic ?? false;
  }

  /**
   * Check if type is special (attachment, note, annotation)
   */
  isSpecial(itemType: string): boolean {
    const def = this.getItemType(itemType);
    return def?.isSpecial ?? false;
  }

  /**
   * Get ordered field definitions for a type
   */
  getOrderedFields(itemType: string): ItemFieldDefinition[] {
    const def = this.getItemType(itemType);
    return def ? [...def.fields] : [];
  }

  /**
   * Check if a field is valid for a given item type
   */
  isValidFieldForType(itemType: string, fieldKey: string): boolean {
    const def = this.getItemType(itemType);
    if (!def) return false;
    return def.fields.some((f) => f.key === fieldKey);
  }

  /**
   * Get valid creator roles for an item type
   */
  getValidCreatorTypes(itemType: string): CreatorTypeDefinition[] {
    const def = this.getItemType(itemType);
    return def ? [...def.creatorTypes] : [];
  }

  /**
   * Get primary creator type for an item type (e.g. author, programmer, director, inventor)
   */
  getPrimaryCreatorType(itemType: string): string {
    const def = this.getItemType(itemType);
    return def?.primaryCreatorType ?? 'author';
  }

  /**
   * Check if a creator role is valid for a given item type
   */
  isValidCreatorType(itemType: string, creatorType: string): boolean {
    const valid = this.getValidCreatorTypes(itemType);
    return valid.some((c) => c.creatorType === creatorType);
  }

  /**
   * Get base-field mapping for an item type (baseField -> type-specific field)
   */
  getBaseFieldMapping(itemType: string): Record<string, string> {
    const normalized = this.normalizeTypeKey(itemType);
    return this.snapshot.baseFieldMappings[normalized] || {};
  }

  /**
   * Get reverse base-field mapping (type-specific field -> baseField)
   */
  getReverseBaseFieldMapping(itemType: string): Record<string, string> {
    const normalized = this.normalizeTypeKey(itemType);
    return this.snapshot.reverseBaseFieldMappings[normalized] || {};
  }

  /**
   * Get the base field equivalent for a type-specific field
   */
  getBaseFieldFor(itemType: string, fieldKey: string): string | undefined {
    const reverse = this.getReverseBaseFieldMapping(itemType);
    return reverse[fieldKey] || fieldKey;
  }

  /**
   * Get the type-specific field for a base field in target itemType
   */
  getTypeSpecificFieldFor(
    itemType: string,
    baseField: string,
  ): string | undefined {
    const mapping = this.getBaseFieldMapping(itemType);
    return mapping[baseField] || baseField;
  }

  resolveBaseFieldMapping(
    fromType: string,
    toType: string,
    fieldKey: string,
  ): { targetField: string; baseSemantic: string } | undefined {
    const baseField = this.getBaseFieldFor(fromType, fieldKey);
    if (!baseField) return undefined;
    const targetField = this.getTypeSpecificFieldFor(toType, baseField);
    if (!targetField) return undefined;
    return {
      targetField,
      baseSemantic: baseField,
    };
  }

  /**
   * Return all creator roles map
   */
  getAllCreatorRoles(): Record<string, string> {
    return { ...this.snapshot.creatorRoles };
  }

  /**
   * Return distinct field keys across all item types
   */
  getDistinctFieldKeys(): string[] {
    return [...this.snapshot.distinctFieldKeys];
  }

  /**
   * Robust item type normalizer without destructive aliasing
   */
  normalizeItemType(rawType: string | undefined | null): string {
    if (!rawType || typeof rawType !== 'string') {
      return 'journalArticle';
    }

    const trimmed = rawType.trim();
    const lower = trimmed.toLowerCase();

    // Direct case-insensitive match against canonical 40 types
    const matchedKey = Object.keys(this.snapshot.itemTypes).find(
      (k) => k.toLowerCase() === lower,
    );
    if (matchedKey) {
      return matchedKey;
    }

    // Extended mapping for external providers (Crossref, arXiv, OpenAlex, Semantic Scholar, BibTeX)
    const aliases: Record<string, string> = {
      // arXiv / preprints
      preprint: 'preprint',
      'working-paper': 'preprint',
      'working paper': 'preprint',
      eprint: 'preprint',
      'posted-content': 'preprint',
      postedcontent: 'preprint',

      // Software / Code
      software: 'computerProgram',
      'software-code': 'computerProgram',
      code: 'computerProgram',
      program: 'computerProgram',
      computerprogram: 'computerProgram',
      algorithm: 'computerProgram',

      // Datasets
      dataset: 'dataset',
      data: 'dataset',
      database: 'dataset',
      'data-set': 'dataset',

      // Standards & Norms
      standard: 'standard',
      norm: 'standard',
      specification: 'standard',
      rfc: 'standard',

      // Journal & Articles
      journalarticle: 'journalArticle',
      'journal-article': 'journalArticle',
      article: 'journalArticle',
      paper: 'journalArticle',
      peer_review: 'journalArticle',

      // Conferences & Proceedings
      conferencepaper: 'conferencePaper',
      'proceedings-article': 'conferencePaper',
      proceedings: 'conferencePaper',
      conference: 'conferencePaper',
      inproceedings: 'conferencePaper',
      paper_conference: 'conferencePaper',

      // Books & Sections
      book: 'book',
      monograph: 'book',
      'edited-book': 'book',
      booksection: 'bookSection',
      'book-section': 'bookSection',
      'book-chapter': 'bookSection',
      incollection: 'bookSection',
      inbook: 'bookSection',
      chapter: 'bookSection',

      // Theses & Dissertations
      thesis: 'thesis',
      dissertation: 'thesis',
      phdthesis: 'thesis',
      mastersthesis: 'thesis',
      'doctoral-thesis': 'thesis',

      // Reports
      report: 'report',
      'tech-report': 'report',
      techreport: 'report',
      'research-report': 'report',
      whitepaper: 'report',

      // Patents
      patent: 'patent',
      'patent-application': 'patent',

      // Webpage & Online
      webpage: 'webpage',
      'web-page': 'webpage',
      website: 'webpage',
      online: 'webpage',
      blogpost: 'blogPost',
      'blog-post': 'blogPost',

      // Magazines & News
      magazinearticle: 'magazineArticle',
      'magazine-article': 'magazineArticle',
      newspaperarticle: 'newspaperArticle',
      'newspaper-article': 'newspaperArticle',

      // Presentations
      presentation: 'presentation',
      slides: 'presentation',
      talk: 'presentation',
      lecture: 'presentation',

      // Media
      videorecording: 'videoRecording',
      video: 'videoRecording',
      audiorecording: 'audioRecording',
      audio: 'audioRecording',
      podcast: 'podcast',
      film: 'film',
      movie: 'film',
      artwork: 'artwork',
      map: 'map',

      // Legal
      case: 'case',
      statute: 'statute',
      bill: 'bill',
      hearing: 'hearing',

      // Textual
      manuscript: 'manuscript',
      document: 'document',
      doc: 'document',
      misc: 'document',
      letter: 'letter',
      interview: 'interview',
      dictionaryentry: 'dictionaryEntry',
      encyclopediaarticle: 'encyclopediaArticle',
      forumpost: 'forumPost',
      instantmessage: 'instantMessage',
      email: 'email',
    };

    if (aliases[lower]) {
      return aliases[lower];
    }

    // Default fallback
    return 'journalArticle';
  }

  private normalizeTypeKey(key: string): string {
    if (this.snapshot.itemTypes[key]) {
      return key;
    }
    const lower = key.toLowerCase();
    const found = Object.keys(this.snapshot.itemTypes).find(
      (k) => k.toLowerCase() === lower,
    );
    return found || key;
  }
}

export const ItemTypeRegistryService = TypesService;
export type ItemTypeRegistryService = TypesService;
