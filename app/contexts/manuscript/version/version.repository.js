import { PageVersionModel } from "../page/page.schema.js";

export class VersionRepository {
  constructor() {
    this.model = PageVersionModel;
  }
  findManualSaves(pageId) {
    return this.model.find({ page: pageId, eventType: "manual_save" })
      .select("_id title label fileName savedBy createdAt")
      .populate("savedBy", "name avatar")
      .sort({ createdAt: -1 })
      .limit(50);
  }
  findById(id) { return this.model.findById(id); }
  findOne(filter) { return this.model.findOne(filter); }
  create(data) { return this.model.create(data); }
  deleteOne(filter) { return this.model.findOneAndDelete(filter); }
  findHistory(projectPageId) {
    return this.model.find({
      projectPageId,
      eventType: { $in: ["manual_save", "file_created", "file_deleted", "asset_uploaded", "asset_deleted"] },
    }).select("_id eventType title label fileName savedBy createdAt page")
      .populate("savedBy", "name avatar")
      .sort({ createdAt: -1 })
      .limit(200);
  }
  findSnapshotBefore(pageId, timestamp) {
    return this.model.findOne({
      page: pageId,
      eventType: { $in: ["manual_save", "auto_save"] },
      createdAt: { $lte: timestamp },
    }).sort({ createdAt: -1 });
  }
}



