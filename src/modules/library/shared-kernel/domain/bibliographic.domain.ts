/**
 * Unified Bibliographic Utilities Facade
 *
 * Modularized into focused domain utilities:
 * - ./identifier.domain: DOI, arXiv, PMID, ISBN, and direct URL derivation
 * - ./author.domain: Academic author splitting, parsing, cleaning, and institution detection
 * - ./academic-text.domain: Title normalization, abstract cleaning, HTML/TeX stripping, and Zotero item type resolution
 */

export * from './identifier.domain';
export * from './author.domain';
export * from './academic-text.domain';
