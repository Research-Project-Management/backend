/**
 * Scoping model for Storage Nodes in Flux
 */
export enum FileScope {
  Personal = 'Personal', // User personal drive file/folder
  Project = 'Project',   // Shared research project workbench file
  Page = 'Page',         // LaTeX / TipTap manuscript asset
  Library = 'Library',   // Academic paper PDF / BibTeX attachment (hidden from personal drive)
  Paper = 'Paper',       // Ingested research paper binary
}

export function isDriveVisible(scope: FileScope | string | null | undefined): boolean {
  if (!scope) return true;
  return scope !== FileScope.Library && scope !== FileScope.Paper;
}
