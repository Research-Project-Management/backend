/**
 * Latex Proxy Route — forwards compile requests to Flux-Latex-Compiler.
 *
 * POST /api/latex/compile
 *   body: { source, engine?, parentPageId?, mainFile?, draft? }
 *   → 200 { pdf: base64, synctex: string }
 *   → 400 { error }        (bad engine)
 *   → 422 { error, log }   (compilation failed — TeX log included)
 *   → 503 { error }        (compiler overloaded — will auto-retry)
 *
 * File sync strategy:
 *   Files are synced to the compiler's persistent project folder by the
 *   page/asset routes whenever content changes.
 *   On compile we only send the current editor source + the project folder ID.
 *
 * Auto-retry: when the compiler returns 503 (all slots busy), the proxy
 * retries up to MAX_RETRIES times with exponential backoff before giving up.
 */

import { Router } from "express";
import { isAuthenticated } from "../middleware/checkWorkspaceRole.js";
import {
  validateRootPage,
  checkCompilerFolderExists,
  bulkSyncToCompiler,
  buildRelativePath,
  textToBase64,
} from "../libs/compiler-sync.js";

const latexRouter = Router();

const LATEX_URL = process.env.LATEX_URL || "http://localhost:2918";
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500; // exponential backoff base

/**
 * Sleep helper for retry backoff.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

latexRouter.post("/compile", isAuthenticated, async (req, res) => {
  try {
    // Accept both project_id (from frontend) and parentPageId
    const { source, engine, parentPageId, project_id, mainFile, main_file, draft } = req.body;
    
    // Normalize: use project_id as parentPageId if parentPageId not provided
    const resolvedParentPageId = parentPageId || project_id;
    // Normalize mainFile parameter — must be defined before auto-sync uses it.
    const resolvedMainFile = mainFile || main_file || "main.tex";

    // Validate parentPageId is a root page
    if (resolvedParentPageId) {
      try {
        await validateRootPage(resolvedParentPageId);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }

    // In fast mode (no project), source is required.
    // In project mode (parentPageId provided), source is optional — compiler
    // uses the project's synced files instead.
    if (!resolvedParentPageId && (!source || typeof source !== "string")) {
      return res
        .status(400)
        .json({ error: "Missing or invalid 'source' field in fast mode" });
    }

    // Auto-sync if compiler folder is missing or the main file is not present.
    if (resolvedParentPageId) {
      const { exists: folderExists, files: compilerFiles } = await checkCompilerFolderExists(resolvedParentPageId);
      // Normalise the main file name the same way the compiler does.
      const resolvedMainFileNorm = resolvedMainFile.endsWith(".tex") ? resolvedMainFile : `${resolvedMainFile}.tex`;
      const mainFilePresent = folderExists && compilerFiles.some(
        (f) => f === resolvedMainFileNorm || f.endsWith(`/${resolvedMainFileNorm}`)
      );

      if (!mainFilePresent) {
        console.log(`[latex] Compiler folder/main-file missing for ${resolvedParentPageId} (${resolvedMainFile}), auto-syncing...`);

        try {
          const PageModel = (await import("../schema/page.js")).default;
          const FileModel = (await import("../schema/file.js")).default;
          const { r2 } = (await import("../config/r2.js"));
          const { GetObjectCommand } = (await import("@aws-sdk/client-s3"));

          const rootPage = await PageModel.findById(resolvedParentPageId).select("content project mainFile").lean();
          if (!rootPage) {
            throw new Error(`Root page not found: ${resolvedParentPageId}`);
          }
          const childFiles = await PageModel.find({ parentPage: rootPage._id })
            .select("_id title content").lean();

          // Build file map from child pages (root page itself has no LaTeX content).
          // Child named "main.tex" (or mainFile title) is the root LaTeX document.
          const files = {};
          for (const child of childFiles) {
            const texName = child.title.endsWith(".tex") ? child.title : `${child.title}.tex`;
            files[texName] = textToBase64(child.content || "");
          }

          // Sync binary assets filtered by this root page only.
          const binaryFiles = await FileModel.find({
            pageId: rootPage._id,
            trashedAt: null,
            isFolder: false,
            url: { $exists: true, $ne: null },
          }).lean();

          for (const bf of binaryFiles) {
            try {
              const key = bf.url?.split("/api/files/")[1];
              if (!key) continue;
              const r2Resp = await r2.send(new GetObjectCommand({
                Bucket: process.env.R2_BUCKET_NAME,
                Key: key,
              }));
              const chunks = [];
              for await (const chunk of r2Resp.Body) chunks.push(chunk);
              const b64 = Buffer.concat(chunks).toString("base64");
              const relPath = await buildRelativePath(bf.filename, bf.parent);
              files[relPath] = b64;
            } catch (err) {
              console.warn(`[latex] Failed to sync asset ${bf.filename}:`, err.message);
            }
          }

          if (Object.keys(files).length > 0) {
            await bulkSyncToCompiler(resolvedParentPageId, files);
          }
          console.log(`[latex] Auto-sync completed for ${resolvedParentPageId} (${Object.keys(files).length} files)`);
        } catch (syncErr) {
          console.error("[latex] Auto-sync failed:", syncErr);
          return res.status(500).json({
            error: "auto_sync_failed",
            message: "Failed to sync project to compiler. Please try again.",
            details: syncErr.message,
          });
        }
      } else {
        console.log(`[latex] Compiler folder ready for ${resolvedParentPageId} (${compilerFiles.length} files)`);
      }
    }

    const allowed = ["pdflatex", "xelatex", "lualatex"];
    const selectedEngine =
      engine && allowed.includes(engine) ? engine : "pdflatex";

    console.log(
      `[latex] compile — engine=${selectedEngine} main=${resolvedMainFile} project=${resolvedParentPageId || "(fast/no-project)"} draft=${!!draft}`,
    );

    const payload = {
      source: source ?? "",            // "" = project-mode, compiler uses synced files
      engine: selectedEngine,
      project_id: resolvedParentPageId || null,
      main_file: resolvedMainFile,
      draft: !!draft,
    };

    // Retry loop — handles 503 (compiler busy) with exponential backoff.
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(
          `[latex] retry ${attempt}/${MAX_RETRIES} after ${delay}ms`,
        );
        await sleep(delay);
      }

      try {
        const upstream = await fetch(`${LATEX_URL}/compile`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        // 503 = compiler overloaded → retry
        if (upstream.status === 503 && attempt < MAX_RETRIES) {
          console.log("[latex] compiler busy (503), will retry…");
          lastError = { status: 503 };
          continue;
        }

        if (upstream.ok) {
          const contentType = upstream.headers.get("content-type") || "";
          if (contentType.includes("application/json")) {
            const data = await upstream.json();
            return res.json(data);
          } else {
            // Legacy compiler: returns raw PDF bytes
            const arrayBuffer = await upstream.arrayBuffer();
            const pdfBase64 = Buffer.from(arrayBuffer).toString("base64");
            return res.json({ pdf: pdfBase64, synctex: "" });
          }
        }

        // Forward error body (422 compilation_failed, 400 invalid_engine, etc.)
        let errorBody;
        try {
          errorBody = await upstream.json();
        } catch {
          errorBody = { error: "upstream_error", message: upstream.statusText };
        }
        return res.status(upstream.status).json(errorBody);
      } catch (fetchError) {
        lastError = fetchError;
        if (attempt < MAX_RETRIES) {
          console.log(`[latex] fetch error, will retry: ${fetchError.message}`);
          continue;
        }
      }
    }

    // All retries exhausted
    console.error("[latex] all retries exhausted:", lastError);
    return res.status(502).json({
      error: "latex_service_unavailable",
      message:
        lastError?.message ||
        "Compiler is overloaded. Please try again in a moment.",
    });
  } catch (error) {
    console.error("[latex] proxy error:", error);

    if (error.message?.includes("Page not found") || error.message?.includes("Only root pages")) {
      return res.status(400).json({
        error: "invalid_page_id",
        message: "Invalid page ID provided for compilation.",
        details: error.message,
      });
    }

    return res
      .status(502)
      .json({ error: "latex_service_unavailable", message: error.message });
  }
});

export default latexRouter;
