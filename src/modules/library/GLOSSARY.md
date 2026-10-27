# Library

The Library bounded context manages academic references, full-text attachments, annotations, hierarchical collections, and citation formatting for research projects.

## Language

### Bibliographic & Curation

**Bibliographic Item**:
A single scholarly work (e.g., journal article, conference paper, preprint, book, thesis) curated inside a user's personal or project library.
_Avoid_: Document, paper, article, record, reference entry

**Creator**:
A person or institution credited with a specific role (`author`, `editor`, `translator`, `seriesEditor`) on a Bibliographic Item, preserving two-field (`firstName` + `lastName`) or single-field institutional (`fieldMode = 1`) attribution.
_Avoid_: Writer, owner, user

**Field Provenance**:
The origin record attached to an individual field of a Bibliographic Item, capturing which source (`Crossref`, `PubMed`, `arXiv`, `LocalPDFExtraction`, `AIMetadata`, `UserOverride`) supplied the value and its confidence score.
_Avoid_: Field history, audit log, metadata source

**Authority Weight**:
The domain ranking score (`0.0` to `1.0`) assigned to a metadata provider for a specific bibliographic field, governing whether an incoming value can overwrite an existing value during multi-provider synthesis.
_Avoid_: Priority number, trust score, provider rank

**User Override Lock**:
An immutable curation lock placed on a field after a researcher manually edits it (`authority = 1.0`), preventing any automated enrichment, PDF extraction, or AI backfill from overwriting the researcher's value.
_Avoid_: Frozen field, readonly flag, manual pin

**Canonical Identifier**:
A normalized, scheme-validated persistent identifier (`DOI`, `ISBN`, `ISSN`, `PMID`, `PMCID`, `arXiv ID`) stripped of URL wrappers, prefixes, and formatting noise.
_Avoid_: Raw ID, external key, link string

**Citation Disambiguation Guard**:
The verification rule that distinguishes the primary identifier of a work from identifiers cited inside its bibliography or "References" section, preventing cited works from hijacking the identity of the uploaded paper.
_Avoid_: Reference filter, DOI blacklist

**Duplicate Merge Memento**:
A reversible snapshot captured before merging duplicate Bibliographic Items, allowing full restoration of consolidated secondary items, contributors, and user override locks upon undo.
_Avoid_: Merge backup, undo log

### Discovery & Organization

**Collection**:
A user-organized folder (supporting nested hierarchy) that groups Bibliographic Items via many-to-many membership without duplicating the underlying items.
_Avoid_: Category, directory, group

**Smart Folder (`SavedSearch`)**:
A dynamic virtual collection defined by a boolean tree (`AND` / `OR`) of field conditions whose membership and item count are evaluated against the live catalog.
_Avoid_: Filter preset, static query

**Page Anchor**:
An exact character-offset and page-index match within an attachment's extracted full text, returned with a contextual snippet for in-document navigation.
_Avoid_: Search hit, PDF bookmark

### Citation & Export

**Citation Key (`citationKey`)**:
A deterministic human-readable handle (e.g., `vaswani2017attention`) uniquely identifying a Bibliographic Item within BibTeX, LaTeX, and CSL citation workflows, retaining `mergedCitationKeys` aliases when duplicates are merged.
_Avoid_: Slug, short code, BibTeX ID
