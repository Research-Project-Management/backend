import { asyncHandler } from "../../../lib/asyncHandler.js";

export class LabelController {
  constructor({ labelService }) {
    this.labelService = labelService;
    this.getLabels = asyncHandler(async (req, res) => { res.json({ labels: await this.labelService.getLabels(req.workspace._id, req.query.type) }); });
    this.createLabel = asyncHandler(async (req, res) => { res.status(201).json({ label: await this.labelService.createLabel(req.workspace._id, req.body, req.user._id) }); });
    this.updateLabel = asyncHandler(async (req, res) => { res.json({ label: await this.labelService.updateLabel(req.params.labelId, req.body, req.user._id) }); });
    this.deleteLabel = asyncHandler(async (req, res) => { await this.labelService.deleteLabel(req.params.labelId, req.user._id); res.status(204).end(); });
  }
}



