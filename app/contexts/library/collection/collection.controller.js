import { asyncHandler } from "../../../lib/asyncHandler.js";

export class CollectionController {
  constructor({ collectionService }) {
    this.collectionService = collectionService;

    this.getCollections = asyncHandler(async (req, res) => {
      const workspaceId = req.workspace ? req.workspace._id : req.project?.workspace;
      const collections = await this.collectionService.getCollections(workspaceId);
      // Filter by project if projectId is present
      const filtered = req.project ? collections.filter(c => c.project?.toString() === req.project._id.toString()) : collections;
      res.json({ collections: filtered });
    });

    this.createCollection = asyncHandler(async (req, res) => {
      const workspaceId = req.workspace ? req.workspace._id : req.project?.workspace;
      const projectId = req.project ? req.project._id : req.body.projectId;
      const body = { ...req.body, project: projectId };
      const collection = await this.collectionService.createCollection(
        workspaceId,
        req.user._id,
        body
      );
      res.status(201).json({ collection });
    });

    this.updateCollection = asyncHandler(async (req, res) => {
      const collection = await this.collectionService.updateCollection(
        req.workspace._id,
        req.params.collectionId,
        req.body
      );
      res.json({ collection });
    });

    this.deleteCollection = asyncHandler(async (req, res) => {
      await this.collectionService.deleteCollection(
        req.workspace._id,
        req.params.collectionId
      );
      res.status(204).end();
    });
  }
}

