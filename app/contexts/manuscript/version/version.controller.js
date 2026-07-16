import { asyncHandler } from "../../../lib/asyncHandler.js";

export class VersionController {
  constructor({ versionService }) {
    this.versionService = versionService;
    this.getVersions = asyncHandler(async (req, res) => { res.json({ versions: await this.versionService.getVersions(req.params.pageId) }); });
    this.createVersion = asyncHandler(async (req, res) => { res.status(201).json({ version: await this.versionService.createVersion(req.params.pageId, req.body, req.user._id) }); });
    this.restoreVersion = asyncHandler(async (req, res) => { res.json({ page: await this.versionService.restoreVersion(req.params.pageId, req.params.versionId) }); });
    this.deleteVersion = asyncHandler(async (req, res) => { await this.versionService.deleteVersion(req.params.pageId, req.params.versionId); res.status(204).end(); });
    this.getHistory = asyncHandler(async (req, res) => { res.json({ events: await this.versionService.getHistory(req.params.pageId) }); });
    this.restoreHistory = asyncHandler(async (req, res) => { res.json(await this.versionService.restoreHistory(req.params.pageId, req.params.eventId)); });
  }
}



