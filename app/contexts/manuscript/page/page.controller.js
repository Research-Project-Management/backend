import { AppError } from "../../../lib/AppError.js";
import { asyncHandler } from "../../../lib/asyncHandler.js";

export class PageController {
  constructor({ pageService, fileService }) {
    this.pageService = pageService;
    this.fileService = fileService;
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

    // Assets integrated via FileService
    this.uploadAsset = asyncHandler(async (req, res) => { 
      const { fileName } = req.body;
      if (!fileName) return res.status(400).json({ error: "fileName is required" });
      const key = `project/${req.params.projectId}/pages/${req.params.pageId}/assets/${Date.now()}-${fileName}`;
      res.json(await this.fileService.presign({ filename: key })); 
    });
    this.getAssets = asyncHandler(async (req, res) => { 
      res.json({ assets: await this.fileService.getPageFiles(req.params.pageId, req.query) }); 
    });
    this.deleteAsset = asyncHandler(async (req, res) => { 
      await this.fileService.deleteFile(req.params.assetId, req.user._id); 
      res.status(204).end(); 
    });
    this.getAssetRaw = asyncHandler(async (req, res) => { 
      const f = await this.fileService.getFile(req.params.assetId);
      if (!f || !f.url) return res.status(404).end();
      const key = f.url.split("/api/files/")[1];
      if (!key) return res.status(404).end();
      await this.fileService.proxyR2(key, res); 
    });


    this.setMainFile = asyncHandler(async (req, res) => {
      const page = await this.pageService.setMainFile(req.params.pageId, req.body.fileId);
      res.json({ page });
    });

    this.updateThumbnail = asyncHandler(async (req, res) => {
      const page = await this.pageService.updateThumbnail(req.params.pageId, req.body.dataUrl);
      res.json({ page });
    });

    this.syncProject = asyncHandler(async (req, res) => {
      const result = await this.pageService.syncProject(req.params.pageId);
      res.json(result);
    });
  }
}
