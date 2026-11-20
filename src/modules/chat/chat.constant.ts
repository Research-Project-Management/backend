export const MAX_CHAT_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB max for images
export const MAX_CHAT_FILE_BYTES = 50 * 1024 * 1024; // 50 MB max for generic files
export const PRESIGNED_UPLOAD_EXPIRES_SECONDS = 900; // 15 minutes
export const PRESIGNED_DOWNLOAD_EXPIRES_SECONDS = 3600; // 1 hour

export const BLOCKED_CHAT_EXTENSIONS = new Set([
  '.exe',
  '.bat',
  '.cmd',
  '.sh',
  '.msi',
  '.vbs',
  '.com',
  '.scr',
  '.pif',
  '.cpl',
  '.jar',
  '.gadget',
]);
