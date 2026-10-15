# Manuscripts & LaTeX Editor Domain Glossary

This glossary defines the canonical domain terms across the `manuscripts` bounded context, following the `domain-modeling` and `codebase-design` conventions.

## Core Concepts

- **Manuscript Project (`Project`)**: A collaborative academic writing workspace containing a hierarchical tree of text documents, binary assets, bibliography databases, and version snapshots.
- **Root Document (`RootDoc`)**: The primary `.tex` entry-point file of a Manuscript Project (containing `\documentclass`) from which compilation starts. Resolved in strict priority order: explicit compile target $\rightarrow$ structure node marked `isRootDoc` $\rightarrow$ document containing `\documentclass` $\rightarrow$ project's configured `mainFile` (`main.tex` by default).
- **Manuscript Document (`Doc`)**: A line-oriented text file (`.tex`, `.bib`, `.sty`, `.cls`, `.bst`, `.md`) stored in `Docstore` with a SHA-256 content hash, monotonic version counter, and optional Cold Archive state.
- **Binary Asset (`File`)**: A non-text file (`.png`, `.jpg`, `.pdf`, `.eps`, `.ttf`) stored as a binary stream in `Filestore` and materialized into the compiler workspace for `\includegraphics` or font loading.
- **Structure Node (`Node`)**: An entry (`DOC`, `FILE`, or `FOLDER`) in a project's hierarchical file tree that maps a human-readable relative path (e.g., `chapters/intro.tex`) to either a `Doc` or a `File`.
- **Cold Archive (`ArchivedDoc`)**: A storage state (`inStorage: true`) where an inactive document's lines are compressed with Gzip and persisted to cold storage (disk/object storage), transparently unarchived on read or compilation.
- **Incremental Workspace (`ScratchWorkspace`)**: A project-scoped compilation directory on disk where only modified text documents and binary assets (detected via SHA-256 hash comparison) are rewritten between builds, preserving TeX auxiliary files (`.aux`, `.bbl`, `.toc`, `.fdb_latexmk`) for fast incremental compilation.
- **SyncTeX Map (`SyncTeXData`)**: The bidirectional geometric mapping between source `(file, line, column)` coordinates and rendered PDF `(page, x, y, width, height)` bounding boxes in PostScript points (`bp`), indexed in a 2D k-d tree.
- **Track Change Suggestion (`Suggestion`)**: A proposed `insert`, `delete`, or `replace` text mutation anchored to a line/column range in a `Doc` with lifecycle status `pending`, `accepted`, or `rejected`.
- **Project Snapshot (`Snapshot`)**: An immutable point-in-time capture of all non-deleted documents and paths in a Manuscript Project, supporting Myers line diffing, human-readable labels, and full restoration.
- **Linked File (`LinkedFile`)**: A project node synchronized from an external URL or upstream project source, supporting manual or scheduled auto-refresh.
