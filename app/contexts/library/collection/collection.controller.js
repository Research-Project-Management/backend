import { asyncHandler } from "../../../lib/asyncHandler.js";

export class CollectionController {
  constructor({ collectionService }) {
    this.collectionService = collectionService;

    this.getCollections = asyncHandler(async (req, res) => {
      const collections = await this.collectionService.getCollections(req.workspace._id);
      res.json({ collections });
    });

    this.createCollection = asyncHandler(async (req, res) => {
      const collection = await this.collectionService.createCollection(
        req.workspace._id,
        req.user._id,
        req.body
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

