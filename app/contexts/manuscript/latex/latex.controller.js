import { asyncHandler } from "../../../lib/asyncHandler.js";

export class LatexController {
  constructor({ latexService }) {
    this.latexService = latexService;
    this.syncProject = asyncHandler(async (req, res) => { res.json(await this.latexService.syncProject(req.params.pageId, req.user._id)); });
    this.syncIncremental = asyncHandler(async (req, res) => { res.json(await this.latexService.syncIncremental(req.params.pageId, req.body)); });
    this.compile = asyncHandler(async (req, res) => {
      const { source, engine, parentPageId, project_id, mainFile, main_file, draft, use_cache } = req.body;
      const resolvedParentPageId = parentPageId || project_id;
      const resolvedMainFile = mainFile || main_file || "main.tex";

      if (!resolvedParentPageId && (!source || typeof source !== "string")) {
        return res.status(400).json({ error: "Missing or invalid 'source' field in fast mode" });
      }

      const allowed = ["pdflatex", "xelatex", "lualatex"];
      const selectedEngine = engine && allowed.includes(engine) ? engine : "pdflatex";

      const payload = {
        source: source ?? "",
        engine: selectedEngine,
        project_id: resolvedParentPageId || null,
        main_file: resolvedMainFile,
        draft: !!draft,
        use_cache: use_cache !== false,
      };

      try {
        const result = await this.latexService.compile(payload);
        res.status(result.status).json(result.data);
      } catch (error) {
        if (error.message?.includes("Page not found") || error.message?.includes("Only root pages")) {
          return res.status(400).json({ error: "invalid_page_id", message: "Invalid page ID provided for compilation.", details: error.message });
        }
        throw error;
      }
    });
  }
}



