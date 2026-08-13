import { asyncHandler } from "../../../lib/asyncHandler.js";

export class ReferenceController {
  constructor({ referenceService }) {
    this.referenceService = referenceService;

    this.crossrefSearch = asyncHandler(async (req, res) => {
      res.json(await this.referenceService.crossrefSearch(req.query.query, req.query.rows));
    });

    this.crossrefDoi = asyncHandler(async (req, res) => {
      res.json(await this.referenceService.crossrefDoi(req.params[0]));
    });
  }
}
