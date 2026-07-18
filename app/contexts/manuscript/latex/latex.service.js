import { AppError } from "../../../lib/AppError.js";
import { syncFileToCompilerReliable, bulkSyncToCompiler } from "../../../lib/compiler-sync.js";
import { r2 } from "../../../config/r2.js";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";


function pageTexName(page) { return (page.title || "untitled").replace(/[^a-z0-9_-]/gi, "_").toLowerCase() + ".tex"; }
function textToBase64(text) { return Buffer.from(text || "", "utf8").toString("base64"); }

function deduplicateTexNames(files) {
  const counts = {};
  files.forEach((f) => { const n = pageTexName(f); counts[n] = (counts[n] || 0) + 1; });
  const nameMap = new Map();
  const seen = {};
  files.forEach((f) => {
    let n = pageTexName(f);
    if (counts[n] > 1) { seen[n] = (seen[n] || 0) + 1; n = n.replace(".tex", "_" + seen[n] + ".tex"); }
    nameMap.set(f._id.toString(), n);
  });
  return nameMap;
}

export class LatexService {
  constructor({ pageRepository, fileRepository }) {
    this.pageRepository = pageRepository;
    this.fileRepository = fileRepository;
  }

  async buildRelativePath(filename, parentId) {
    if (!parentId) return filename;
    const parent = await this.fileRepository.findOneById(parentId);
    if (!parent) return filename;
    const parentPath = await this.buildRelativePath(parent.filename, parent.parent);
    return parentPath + "/" + filename;
  }

  async syncProject(rootPageId, userId) {
    const rootPage = await this.pageRepository.findByIdSelect(rootPageId, "_id title content parentPage");
    if (!rootPage) throw new AppError("Page not found", 404);
    if (rootPage.parentPage) throw new AppError("Only root pages can sync a project", 400);
    const folderId = rootPage._id.toString();
    const childFiles = await this.pageRepository.findChildPages(rootPage._id);
    const allFiles = [rootPage.toObject ? rootPage.toObject() : rootPage, ...childFiles];
    const nameMap = deduplicateTexNames(allFiles);
    const files = {};
    files[nameMap.get(rootPage._id.toString()) ?? pageTexName(rootPage)] = textToBase64(rootPage.content ?? "");
    for (const f of childFiles) {
      files[nameMap.get(f._id.toString()) ?? pageTexName(f)] = textToBase64(f.content ?? "");
    }
    const binaryFiles = await this.fileRepository.findByPageId(rootPage._id);
    for (const bf of binaryFiles) {
      try {
        const key = bf.url?.split("/api/files/")[1];
        if (!key) continue;
        const r2Resp = await r2.send(new GetObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
        const chunks = []; for await (const chunk of r2Resp.Body) chunks.push(chunk);
        const b64 = Buffer.concat(chunks).toString("base64");
        const relPath = await this.buildRelativePath(bf.filename, bf.parent);
        files[relPath] = b64;
      } catch (err) { console.warn("[sync-project] failed asset:", err.message); }
    }
    if (Object.keys(files).length === 0) return { ok: true, synced: 0 };
    await bulkSyncToCompiler(folderId, files);
    return { ok: true, synced: Object.keys(files).length };
  }

  async syncIncremental(rootPageId, { dirtyFileIds = [], forceAll = false }) {
    const rootPage = await this.pageRepository.findByIdSelect(rootPageId, "_id title content parentPage");
    if (!rootPage) throw new AppError("Page not found", 404);
    if (rootPage.parentPage) throw new AppError("Only root pages can sync", 400);
    const folderId = rootPage._id.toString();
    const dirtySet = new Set(dirtyFileIds.map(String));
    const childFiles = await this.pageRepository.findChildPagesWithMeta(rootPage._id);
    const nameMap = deduplicateTexNames(childFiles);
    const toSync = (!forceAll && dirtySet.size > 0) ? childFiles.filter((f) => dirtySet.has(f._id.toString())) : childFiles;
    const syncedIds = [];
    const syncedNames = {};
    await Promise.allSettled(toSync.map(async (file) => {
      const texName = nameMap.get(file._id.toString()) ?? pageTexName(file);
      try {
        await syncFileToCompilerReliable(folderId, texName, textToBase64(file.content ?? ""));
        syncedIds.push(file._id.toString());
        syncedNames[file._id.toString()] = texName;
      } catch (err) { console.warn("[sync-incremental] failed:", err.message); }
    }));
    return { synced: syncedIds, names: syncedNames, total: syncedIds.length };
  }

  async compile(payload) {
    if (payload.project_id) {
      const rootPage = await this.pageRepository.findByIdSelect(payload.project_id, "_id parentPage");
      if (!rootPage) throw new AppError("Page not found", 404);
      if (rootPage.parentPage) throw new AppError("Only root pages can be compiled directly.", 400);
    }

    const LATEX_URL = process.env.LATEX_URL || "http://localhost:2918";
    const MAX_RETRIES = 3;
    const BASE_DELAY_MS = 500;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await sleep(delay);
      }

      try {
        const upstream = await fetch(`${LATEX_URL}/compile`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (upstream.status === 503 && attempt < MAX_RETRIES) {
          lastError = { status: 503 };
          continue;
        }

        if (upstream.ok) {
          const contentType = upstream.headers.get("content-type") || "";
          if (contentType.includes("application/json")) {
            const data = await upstream.json();
            return { status: 200, data };
          } else {
            const arrayBuffer = await upstream.arrayBuffer();
            const pdfBase64 = Buffer.from(arrayBuffer).toString("base64");
            return { status: 200, data: { pdf: pdfBase64, synctex: "" } };
          }
        }

        let errorBody;
        try {
          errorBody = await upstream.json();
        } catch {
          errorBody = { error: "upstream_error", message: upstream.statusText };
        }
        return { status: upstream.status, data: errorBody };
      } catch (fetchError) {
        lastError = fetchError;
        if (attempt < MAX_RETRIES) {
          continue;
        }
      }
    }

    throw new AppError(lastError?.message || "Compiler is overloaded. Please try again in a moment.", 502);
  }
}



