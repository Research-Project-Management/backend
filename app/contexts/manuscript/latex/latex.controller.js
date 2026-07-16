import { asyncHandler } from "../../../lib/asyncHandler.js";

export class LatexController {
  constructor({ latexService }) {
    this.latexService = latexService;
    this.syncProject = asyncHandler(async (req, res) => { res.json(await this.latexService.syncProject(req.params.pageId, req.user._id)); });
    this.syncIncremental = asyncHandler(async (req, res) => { res.json(await this.latexService.syncIncremental(req.params.pageId, req.body)); });
    this.proxyToCompiler = asyncHandler(async (req, res) => { await this.latexService.proxy(req, res); });
  }
}



