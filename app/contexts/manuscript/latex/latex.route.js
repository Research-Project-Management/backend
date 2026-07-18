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

export const buildLatexRouter = (latexController) => {
  const latexRouter = Router();

  latexRouter.post("/compile", isAuthenticated, latexController.compile);

  return latexRouter;
};
