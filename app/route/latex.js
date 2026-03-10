/**
 * Latex Proxy Route — forwards compile requests to Flux-Latex-Compiler.
 *
 * POST /api/latex/compile
 *   body: { source: string, engine?: "pdflatex" | "xelatex" | "lualatex", parentPageId?: string }
 *   → 200 application/pdf  (PDF binary)
 *   → 400 { error }        (bad engine)
 *   → 422 { error, log }   (compilation failed  — TeX log included)
 *
 * File sync strategy:
 *   Files (images, sub-.tex files) are synced to the compiler's persistent
 *   project folder by the page/asset routes whenever content changes.
 *   On compile we only send the current editor source + the project folder ID.
 */

import { Router } from "express";
import { isAuthenticated } from "../middleware/checkWorkspaceRole.js";

const latexRouter = Router();

const LATEX_URL = process.env.LATEX_URL || "http://localhost:8001";

latexRouter.post("/compile", isAuthenticated, async (req, res) => {
  try {
    const { source, engine, parentPageId } = req.body;

    if (!source || typeof source !== "string") {
      return res
        .status(400)
        .json({ error: "Missing or invalid 'source' field" });
    }

    const allowed = ["pdflatex", "xelatex", "lualatex"];
    const selectedEngine =
      engine && allowed.includes(engine) ? engine : "pdflatex";

    console.log(
      `[latex] compile — engine=${selectedEngine} project=${parentPageId || "(fast/no-project)"}`,
    );

    const upstream = await fetch(`${LATEX_URL}/compile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source,
        engine: selectedEngine,
        project_id: parentPageId || null,
      }),
    });

    if (upstream.ok) {
      const pdfBuffer = Buffer.from(await upstream.arrayBuffer());
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "inline; filename=output.pdf");
      return res.send(pdfBuffer);
    }

    // Forward error body (422 compilation_failed with log, 400 invalid_engine, etc.)
    let errorBody;
    try {
      errorBody = await upstream.json();
    } catch {
      errorBody = { error: "upstream_error", message: upstream.statusText };
    }
    return res.status(upstream.status).json(errorBody);
  } catch (error) {
    console.error("[latex] proxy error:", error);
    return res
      .status(502)
      .json({ error: "latex_service_unavailable", message: error.message });
  }
});

export default latexRouter;
