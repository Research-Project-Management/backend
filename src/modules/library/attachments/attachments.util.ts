export function isPdfMimeType(mimeType?: string | null): boolean {
  return mimeType?.toLowerCase().includes('pdf') ?? false;
}

export function normalizeAttachmentFilename(filename?: string | null): string {
  return filename?.trim().replace(/\s+/g, ' ') || 'attachment';
}

export function getAttachmentExtension(
  filename?: string | null,
): string | null {
  const clean = filename?.trim();
  if (!clean) return null;

  const index = clean.lastIndexOf('.');
  if (index < 0 || index === clean.length - 1) return null;

  return clean.slice(index + 1).toLowerCase();
}
