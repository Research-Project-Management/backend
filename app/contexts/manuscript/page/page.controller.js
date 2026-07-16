import { AppError } from "../../../lib/AppError.js";
import { asyncHandler } from "../../../lib/asyncHandler.js";

export class PageController {
  constructor({ pageService }) {
    this.pageService = pageService;
    this.getWorkspacePages = asyncHandler(async (req, res) => { res.json({ pages: await this.pageService.getWorkspacePages(req.params.workspaceId) }); });
    this.getProjectPages = asyncHandler(async (req, res) => { res.json({ pages: await this.pageService.getProjectPages(req.params.projectId) }); });
    this.createPage = asyncHandler(async (req, res) => { 
      const result = await this.pageService.createPage(req.params.projectId, req.body, req.user._id);
      res.status(201).json(result); 
    });
    this.getPage = asyncHandler(async (req, res) => { const page = await this.pageService.getPage(req.params.pageId); if (!page) throw new AppError("Page not found", 404); res.json({ page }); });
    this.updatePage = asyncHandler(async (req, res) => { res.json({ page: await this.pageService.updatePage(req.params.pageId, req.body, req.user._id) }); });
    this.deletePage = asyncHandler(async (req, res) => { await this.pageService.deletePage(req.params.pageId, req.user._id); res.status(204).end(); });
    this.duplicatePage = asyncHandler(async (req, res) => { res.status(201).json({ page: await this.pageService.duplicatePage(req.params.pageId, req.user._id) }); });
    
    // Child pages (files inside a page project)
    this.getChildPages = asyncHandler(async (req, res) => { 
      res.json({ files: await this.pageService.getChildPages(req.params.pageId) }); 
    });
    this.createChildPage = asyncHandler(async (req, res) => { 
      res.status(201).json({ file: await this.pageService.createChildPage(req.params.pageId, req.body, req.user._id) }); 
    });

    // Stubs for assets to prevent Express from crashing if these routes are hit or registered
    this.uploadAsset = asyncHandler(async (req, res) => { res.status(501).json({ error: "Assets features are not implemented" }); });
    this.getAssets = asyncHandler(async (req, res) => { res.json({ assets: [] }); });
    this.deleteAsset = asyncHandler(async (req, res) => { res.status(204).end(); });
    this.getAssetRaw = asyncHandler(async (req, res) => { res.status(404).end(); });
  }
}



