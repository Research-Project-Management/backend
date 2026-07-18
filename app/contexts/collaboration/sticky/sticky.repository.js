import { StickyModel, StickyChildLinkModel } from "./sticky.schema.js";

export class StickyRepository {
  constructor() {
    this.model = StickyModel;
    this.linkModel = StickyChildLinkModel;
  }
  find(q) { return this.model.find(q).sort({ order: 1, createdAt: -1 }); }
  findById(id) { return this.model.findById(id); }
  create(data) { return this.model.create(data); }
  updateById(id, data) { return this.model.findByIdAndUpdate(id, data, { new: true }); }
  deleteById(id) { return this.model.findByIdAndDelete(id); }
  bulkReorder(ops) { return this.model.bulkWrite(ops); }
  findLinks(parentStickyId, userId) {
    return this.linkModel.find({ parentStickyId: parentStickyId, authorId: userId })
      .select("+childNoteId")
      .populate("childStickyId")
      .populate("childNoteId");
  }
  upsertLink(childStickyId, userId, data) { return this.linkModel.findOneAndUpdate({ childStickyId: childStickyId, authorId: userId }, data, { upsert: true, new: true, setDefaultsOnInsert: true }); }
  deleteLinks(filter) { return this.linkModel.deleteMany(filter); }
  findLink(parentStickyId, childStickyId, userId) { return this.linkModel.findOne({ parentStickyId: parentStickyId, $or: [{ childStickyId: childStickyId }, { childNoteId: childStickyId }], authorId: userId }); }
  deleteLinkById(id) { return this.linkModel.findByIdAndDelete(id); }

  searchStickies(workspaceId, queryStr) {
    const searchRegex = { $regex: queryStr.trim(), $options: "i" };
    return this.model.find({ workspaceId: workspaceId, $or: [{ title: searchRegex }, { content: searchRegex }] })
      .limit(5)
      .select("title content color updatedAt");
  }
}



