import { asyncHandler } from "../../../lib/asyncHandler.js";

// ── Base Controller ───────────────────────────────────────────────────────────
export class CollectionController {
  constructor(service) {
    this.service = service;
  }
  // ── Abstract Route Handlers (Interface) ──────────────────────────────────────
  getCollections(req, res) { throw new Error("Method getCollections not implemented"); }
  getCollection(req, res) { throw new Error("Method getCollection not implemented"); }
  createCollection(req, res) { throw new Error("Method createCollection not implemented"); }
  updateCollection(req, res) { throw new Error("Method updateCollection not implemented"); }
  deleteCollection(req, res) { throw new Error("Method deleteCollection not implemented"); }
}

// ── Workspace Collection Controller ───────────────────────────────────────────
export class WorkspaceCollectionController extends CollectionController {
  constructor({ workspaceCollectionService }) {
    super(workspaceCollectionService);

    this.getCollections = asyncHandler(async (req, res) => {
      const workspaceId = req.workspace ? req.workspace._id : req.project?.workspaceId;
      const collections = await this.service.getCollections(workspaceId);
      // Filter by project if projectId is present
      const filtered = req.project ? collections.filter(c => c.project?.toString() === req.project._id.toString()) : collections;
      res.json({ collections: filtered });
    });

    this.createCollection = asyncHandler(async (req, res) => {
      const workspaceId = req.workspace ? req.workspace._id : req.project?.workspaceId;
      const projectId = req.project ? req.project._id : req.body.projectId;
      const body = { ...req.body, project: projectId };
      const collection = await this.service.createCollection(
        workspaceId,
        req.user._id,
        body
      );
      res.status(201).json({ collection });
    });

    this.updateCollection = asyncHandler(async (req, res) => {
      const collection = await this.service.updateCollection(
        req.workspace._id,
        req.params.collectionId,
        req.body
      );
      res.json({ collection });
    });

    this.deleteCollection = asyncHandler(async (req, res) => {
      await this.service.deleteCollection(
        req.workspace._id,
        req.params.collectionId
      );
      res.status(204).end();
    });
  }
}

// ── Project Collection Controller ─────────────────────────────────────────────
export class ProjectCollectionController extends CollectionController {
  constructor({ projectCollectionService }) {
    super(projectCollectionService);

    this.getCollections = asyncHandler(async (req, res) => {
      const projectCollections = await this.service.getCollections(req.project._id);
      res.json({ projectCollections });
    });

    this.createCollection = asyncHandler(async (req, res) => {
      const projectCollection = await this.service.createCollection(
        req.project._id,
        req.project.workspaceId,
        req.user._id,
        req.body
      );
      res.status(201).json({ projectCollection });
    });

    this.importLibraryCollection = asyncHandler(async (req, res) => {
      const result = await this.service.importLibraryCollectionToExisting(
        req.project._id,
        req.project.workspaceId,
        req.user._id,
        req.params.pcId,
        req.body.collectionId
      );
      res.json(result);
    });

    this.addPaperToProjectCollection = asyncHandler(async (req, res) => {
      const projectCollection = await this.service.addPaperToProjectCollection(
        req.project._id,
        req.project.workspaceId,
        req.user._id,
        req.params.pcId,
        req.body
      );
      res.status(201).json({ projectCollection });
    });

    this.removePaperFromProjectCollection = asyncHandler(async (req, res) => {
      await this.service.removePaperFromProjectCollection(
        req.project._id,
        req.params.pcId,
        req.params.paperId
      );
      res.status(204).end();
    });

    this.deleteCollection = asyncHandler(async (req, res) => {
      await this.service.deleteCollection(
        req.project._id,
        req.params.pcId
      );
      res.status(204).end();
    });
  }
}
