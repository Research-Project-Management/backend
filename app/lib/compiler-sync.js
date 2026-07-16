/**
 * compiler-sync.js — Shared helpers to keep the Flux-Latex-Compiler's
 * persistent project folder in sync with MongoDB/R2.
 *
 * Used by:  app/route/page.js  (tex file sync)
 *           app/route/files.js (binary file sync)
 *
 * All sync functions are await-able and support retry with exponential
 * backoff. A per-folder queue serialises rapid syncs to prevent race
 * conditions (e.g. auto-save firing faster than the compiler can process).
 */

import FileModel from "../contexts/shared/file/file.schema.js";

export const LATEX_URL = process.env.LATEX_URL || "http://localhost:2918";

/**
 * Validate that a pageId is a root page (parentPage: null).
 * Root pages are used as compiler project folders.
 * @param {string} pageId
 * @returns {Promise<{_id: string, title: string}>}
 */
export async function validateRootPage(pageId) {
  const PageModel = (await import("../contexts/manuscript/page/page.schema.js")).default;
  const page = await PageModel.findById(pageId).select("parentPage title").lean();

  if (!page) {
    throw new Error("Page not found");
  }

  if (page.parentPage !== null) {
    throw new Error("Only root pages can be used as compiler project folders");
  }

  return page;
}

/**
 * Check if compiler project folder exists AND optionally if a specific file is present.
 * Returns { exists: boolean, files: string[] } from GET /projects/{folderId}.
 * @param {string} folderId
 * @returns {Promise<{ exists: boolean, files: string[] }>}
 */
export async function checkCompilerFolderExists(folderId) {
  try {
    const resp = await fetch(`${LATEX_URL}/projects/${folderId}`, {
      method: "GET",
    });
    if (!resp.ok) return { exists: false, files: [] };
    const data = await resp.json();
    return { exists: data.exists === true, files: data.files ?? [] };
  } catch (err) {
    console.warn(`[compiler-sync] Failed to check folder ${folderId}:`, err.message);
    return { exists: false, files: [] };
  }
}

const MAX_RETRIES = 2;
const BASE_DELAY_MS = 200;

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

// ── Per-folder sync queue ─────────────────────────────────────────────────────

/**
 * Map<folderId, Promise> — serialises rapid sync calls for the same project
 * so that the compiler always receives files in the order they were saved.
 */
const folderQueues = new Map();

/**
 * Run an async task after all previously-queued tasks for the same folder.
 * Errors are logged but do not break the chain.
 */
function enqueue(folderId, task) {
  const prev = folderQueues.get(folderId) ?? Promise.resolve();
  const next = prev
    .then(() => task())
    .catch((err) => {
      console.warn(`[compiler-sync] queued task failed for ${folderId}:`, err.message);
    });
  folderQueues.set(folderId, next);
  // Prune resolved entries to avoid unbounded growth
  next.finally(() => {
    if (folderQueues.get(folderId) === next) folderQueues.delete(folderId);
  });
  return next;
}

// ── Core sync helpers (await-able) ────────────────────────────────────────────

/**
 * Write a file to the compiler's persistent project folder (await-able).
 * @param {string} folderId  Root page ID (MongoDB ObjectId string).
 * @param {string} filePath  Relative path inside the project, e.g. "images/fig.png".
 * @param {string} base64    Base64-encoded file content.
 */
export async function syncFileToCompiler(folderId, filePath, base64) {
  const resp = await fetch(compilerFilePath(folderId, filePath), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: base64 }),
  });
  if (!resp.ok) {
    throw new Error(`PUT ${folderId}/${filePath} returned ${resp.status}`);
  }
  return resp.json();
}

/**
 * Remove a single file from the compiler's persistent project folder (await-able).
 * @param {string} folderId  Root page ID.
 * @param {string} filePath  Relative path, e.g. "chapters/intro.tex".
 */
export async function deleteFileFromCompiler(folderId, filePath) {
  const resp = await fetch(compilerFilePath(folderId, filePath), { method: "DELETE" });
  if (!resp.ok) {
    throw new Error(`DELETE ${folderId}/${filePath} returned ${resp.status}`);
  }
  return resp.json();
}

/**
 * Remove the entire project folder from the compiler (await-able).
 * @param {string} folderId  Root page ID.
 */
export async function deleteProjectFromCompiler(folderId) {
  const resp = await fetch(`${LATEX_URL}/projects/${folderId}`, { method: "DELETE" });
  if (!resp.ok) {
    throw new Error(`DELETE project ${folderId} returned ${resp.status}`);
  }
  return resp.json();
}

// ── Retry wrappers ────────────────────────────────────────────────────────────

/**
 * Retry wrapper — retries up to `retries` times with linear backoff.
 */
async function withRetry(fn, retries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, BASE_DELAY_MS * (attempt + 1)));
      }
    }
  }
  throw lastError;
}

/**
 * Write a file to the compiler with retry + per-folder queueing.
 * This is the recommended function for all callers.
 */
export function syncFileToCompilerReliable(folderId, filePath, base64) {
  return enqueue(folderId, () =>
    withRetry(() => syncFileToCompiler(folderId, filePath, base64)),
  );
}

/**
 * Delete a single file from the compiler with retry + per-folder queueing.
 */
export function deleteFileFromCompilerReliable(folderId, filePath) {
  return enqueue(folderId, () =>
    withRetry(() => deleteFileFromCompiler(folderId, filePath)),
  );
}

/**
 * Delete an entire project folder from the compiler with retry.
 */
export function deleteProjectFromCompilerReliable(folderId) {
  return withRetry(() => deleteProjectFromCompiler(folderId));
}

// ── Path builder ──────────────────────────────────────────────────────────────

/**
 * Walk up the folder-parent chain (FileModel) to build a relative path.
 *
 * Example: file "photo.png" inside folder "images" → "images/photo.png"
 * Root-level files → "photo.png"
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
  await withRetry(async () => {
    const resp = await fetch(`${LATEX_URL}/projects/${folderId}/sync`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files }),
    });
    if (!resp.ok) {
      throw new Error(`bulk sync for ${folderId} returned ${resp.status}`);
    }
  });
}
