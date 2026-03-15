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
    const { source, engine, parentPageId, mainFile, draft } = req.body;

    if (!source || typeof source !== "string") {
      return res
        .status(400)
        .json({ error: "Missing or invalid 'source' field" });
    }

    const allowed = ["pdflatex", "xelatex", "lualatex"];
    const selectedEngine =
      engine && allowed.includes(engine) ? engine : "pdflatex";

    console.log(
      `[latex] compile — engine=${selectedEngine} main=${mainFile || "main.tex"} project=${parentPageId || "(fast/no-project)"} draft=${!!draft}`,
    );

    const payload = {
      source,
      engine: selectedEngine,
      project_id: parentPageId || null,
      main_file: mainFile || "main.tex",
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
    return res
      .status(502)
      .json({ error: "latex_service_unavailable", message: error.message });
  }
});

export default latexRouter;
