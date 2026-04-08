/**
 * compiler-sync.js — Shared helpers to keep the Flux-Latex-Compiler's
 * persistent project folder in sync with MongoDB/R2.
 *
 * Used by:  app/route/page.js  (tex file sync)
 *           app/route/files.js (binary file sync)
 */

import FileModel from "../schema/file.js";

export const LATEX_URL = process.env.LATEX_URL || "http://localhost:2918";

// ── Encoding helpers ──────────────────────────────────────────────────────────

/** Encode text as base64 (UTF-8). */
export function textToBase64(text) {
  return Buffer.from(text ?? "", "utf8").toString("base64");
}

/**
 * Build a compiler-safe URL path for a file inside a project.
 * Encodes each path segment individually so that folder separators (/)
 * are preserved and the compiler receives the correct sub-directory path.
 *
 * Example:  "images/photo.png"  →  "/projects/{id}/files/images/photo.png"
 */
function compilerFilePath(folderId, filePath) {
  const encoded = filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  return `${LATEX_URL}/projects/${folderId}/files/${encoded}`;
}

// ── Sync helpers (fire-and-forget) ────────────────────────────────────────────

/**
 * Write a file to the compiler's persistent project folder.
 * @param {string} folderId  Root page ID (MongoDB ObjectId string).
 * @param {string} filePath  Relative path inside the project, e.g. "images/fig.png".
 * @param {string} base64    Base64-encoded file content.
 */
export function syncFileToCompiler(folderId, filePath, base64) {
  fetch(compilerFilePath(folderId, filePath), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: base64 }),
  }).catch((err) =>
    console.warn(`[compiler-sync] PUT ${folderId}/${filePath} failed:`, err.message),
  );
}

/**
 * Remove a single file from the compiler's persistent project folder.
 * @param {string} folderId  Root page ID.
 * @param {string} filePath  Relative path, e.g. "chapters/intro.tex".
 */
export function deleteFileFromCompiler(folderId, filePath) {
  fetch(compilerFilePath(folderId, filePath), { method: "DELETE" }).catch(
    (err) =>
      console.warn(`[compiler-sync] DELETE ${folderId}/${filePath} failed:`, err.message),
  );
}

/**
 * Remove the entire project folder from the compiler (e.g. when a page-project
 * is deleted).
 * @param {string} folderId  Root page ID.
 */
export function deleteProjectFromCompiler(folderId) {
  fetch(`${LATEX_URL}/projects/${folderId}`, { method: "DELETE" }).catch(
    (err) =>
      console.warn(`[compiler-sync] DELETE project ${folderId} failed:`, err.message),
  );
}

// ── Path builder ──────────────────────────────────────────────────────────────

/**
 * Walk up the folder-parent chain (FileModel) to build a relative path.
 *
 * Example: file "photo.png" inside folder "images" → "images/photo.png"
 * Root-level files → "photo.png"
 *
 * NOTE: FileModel does NOT have a `pageId` field — we only filter by `_id`
 * and `isFolder`.
 *
 * @param {string} filename   The file's own name.
 * @param {string|null} parentId  The `parent` field value of the FileModel doc.
 * @returns {Promise<string>}
 */
export async function buildRelativePath(filename, parentId) {
  const parts = [filename];
  let currentParentId = parentId;

  while (currentParentId) {
    // eslint-disable-next-line no-await-in-loop
    const parentFolder = await FileModel.findOne({
      _id: currentParentId,
      isFolder: true,
    }).select("filename parent").lean();

    if (!parentFolder) break;
    parts.unshift(parentFolder.filename);
    currentParentId = parentFolder.parent ?? null;
  }

  return parts.join("/");
}

// ── Bulk sync ─────────────────────────────────────────────────────────────────

/**
 * Push multiple files to the compiler in a single PUT /projects/{id}/sync
 * request. Much faster than individual file-by-file PUTs.
 *
 * @param {string} folderId  Root page ID.
 * @param {Record<string, string>} files  { relativePath → base64 }
 * @returns {Promise<void>}
 */
export async function bulkSyncToCompiler(folderId, files) {
  if (!files || Object.keys(files).length === 0) return;
  try {
    const resp = await fetch(`${LATEX_URL}/projects/${folderId}/sync`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files }),
    });
    if (!resp.ok) {
      console.warn(`[compiler-sync] bulk sync for ${folderId} returned ${resp.status}`);
    }
  } catch (err) {
    console.warn(`[compiler-sync] bulk sync for ${folderId} failed:`, err.message);
  }
}
