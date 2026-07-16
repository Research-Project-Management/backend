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
import { isAuthenticated } from "../../../middleware/auth.middleware.js";
import { validateRootPage } from "../../../lib/compiler-sync.js";

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
    const { source, engine, parentPageId, project_id, mainFile, main_file, draft, use_cache } = req.body;
    
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

    // In project mode (project_id provided), the client is responsible for
    // calling /api/pages/:id/sync-incremental before /compile.
    // We only check that source is provided in fast (no-project) mode.
    if (!resolvedParentPageId && (!source || typeof source !== "string")) {
      return res
        .status(400)
        .json({ error: "Missing or invalid 'source' field in fast mode" });
    }

    const allowed = ["pdflatex", "xelatex", "lualatex"];
    const selectedEngine =
      engine && allowed.includes(engine) ? engine : "pdflatex";


    const payload = {
      source: source ?? "",            // "" = project-mode, compiler uses synced files
      engine: selectedEngine,
      project_id: resolvedParentPageId || null,
      main_file: resolvedMainFile,
      draft: !!draft,
      use_cache: use_cache !== false,  // Default to true
    };

    // Retry loop — handles 503 (compiler busy) with exponential backoff.
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

        // 503 = compiler overloaded → retry
        if (upstream.status === 503 && attempt < MAX_RETRIES) {
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

export const buildLatexRouter = () => {
  return latexRouter;
};
