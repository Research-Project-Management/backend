import { asyncHandler } from "../../../lib/asyncHandler.js";

export class PaperController {
  constructor({ paperService, collectionService }) {
    this.paperService = paperService;
    this.collectionService = collectionService;

    this.getCollectionPapers = asyncHandler(async (req, res) => {
      const collection = await this.collectionService.getCollection(req.workspace._id, req.params.collectionId);
      const papers = await this.paperService.getPapersByCollection(req.workspace._id, req.params.collectionId);
      res.json({ collection, papers });
    });

    this.uploadPaperToCollection = asyncHandler(async (req, res) => {
      const collection = await this.collectionService.getCollection(req.workspace._id, req.params.collectionId);
      const paper = await this.paperService.uploadPaper(
        req.workspace._id,
        req.user._id,
        { ...req.body, collectionId: req.params.collectionId }
      );
      res.status(201).json({ paper });
    });

    this.getPapers = asyncHandler(async (req, res) => {
      const papers = await this.paperService.getPapers(req.workspace._id);
      res.json({ papers });
    });

    this.uploadPaper = asyncHandler(async (req, res) => {
      const paper = await this.paperService.uploadPaper(
        req.workspace._id,
        req.user._id,
        req.body
      );
      res.status(201).json({ paper });
    });

    this.triggerReindex = asyncHandler(async (req, res) => {
      const paper = await this.paperService.triggerReindex(
        req.workspace._id,
        req.user._id,
        req.params.paperId
      );
      res.json({ message: "Reindex triggered", paperId: paper._id });
    });

    this.updatePaper = asyncHandler(async (req, res) => {
      const paper = await this.paperService.updatePaper(
        req.workspace._id,
        req.params.paperId,
        req.body
      );
      res.json({ paper });
    });

    this.deletePaper = asyncHandler(async (req, res) => {
      await this.paperService.deletePaper(
        req.workspace._id,
        req.params.paperId
      );
      res.status(204).end();
    });
  }
}

