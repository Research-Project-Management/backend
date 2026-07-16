import { asyncHandler } from "../../../lib/asyncHandler.js";

export class ProjectCollectionController {
  constructor({ projectCollectionService }) {
    this.projectCollectionService = projectCollectionService;

    this.getProjectCollections = asyncHandler(async (req, res) => {
      const projectCollections = await this.projectCollectionService.getProjectCollections(req.project._id);
      res.json({ projectCollections });
    });

    this.createProjectCollection = asyncHandler(async (req, res) => {
      const projectCollection = await this.projectCollectionService.createProjectCollection(
        req.project._id,
        req.project.workspace,
        req.user._id,
        req.body
      );
      res.status(201).json({ projectCollection });
    });

    this.importLibraryCollection = asyncHandler(async (req, res) => {
      const result = await this.projectCollectionService.importLibraryCollectionToExisting(
        req.project._id,
        req.project.workspace,
        req.user._id,
        req.params.pcId,
        req.body.collectionId
      );
      res.json(result);
    });

    this.addPaperToProjectCollection = asyncHandler(async (req, res) => {
      const projectCollection = await this.projectCollectionService.addPaperToProjectCollection(
        req.project._id,
        req.project.workspace,
        req.user._id,
        req.params.pcId,
        req.body
      );
      res.status(201).json({ projectCollection });
    });

    this.removePaperFromProjectCollection = asyncHandler(async (req, res) => {
      await this.projectCollectionService.removePaperFromProjectCollection(
        req.project._id,
        req.params.pcId,
        req.params.paperId
      );
      res.status(204).end();
    });

    this.deleteProjectCollection = asyncHandler(async (req, res) => {
      await this.projectCollectionService.deleteProjectCollection(
        req.project._id,
        req.params.pcId
      );
      res.status(204).end();
    });
  }
}

