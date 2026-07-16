import { StickyModel, StickyChildLinkModel } from "./sticky.schema.js";

export class StickyRepository {
  constructor() {
    this.model = StickyModel;
    this.linkModel = StickyChildLinkModel;
  }
  find(q) { return this.model.find(q).populate("labels", "name color").populate("author", "name avatar").sort({ order: 1, createdAt: -1 }); }
  findById(id) { return this.model.findById(id); }
  create(data) { return this.model.create(data); }
  updateById(id, data) { return this.model.findByIdAndUpdate(id, data, { new: true }).populate("labels", "name color").populate("author", "name avatar"); }
  deleteById(id) { return this.model.findByIdAndDelete(id); }
  bulkReorder(ops) { return this.model.bulkWrite(ops); }
  findLinks(parentStickyId, userId) {
    return this.linkModel.find({ parentSticky: parentStickyId, author: userId })
      .select("+childNote")
      .populate({ path: "childSticky", populate: [{ path: "labels", select: "name color" }, { path: "author", select: "name avatar" }] })
      .populate({ path: "childNote", populate: [{ path: "labels", select: "name color" }, { path: "author", select: "name avatar" }] })
      .populate("project", "name avatar");
  }
  upsertLink(childStickyId, userId, data) { return this.linkModel.findOneAndUpdate({ childSticky: childStickyId, author: userId }, data, { upsert: true, new: true, setDefaultsOnInsert: true }); }
  deleteLinks(filter) { return this.linkModel.deleteMany(filter); }
  findLink(parentStickyId, childStickyId, userId) { return this.linkModel.findOne({ parentSticky: parentStickyId, $or: [{ childSticky: childStickyId }, { childNote: childStickyId }], author: userId }); }
  deleteLinkById(id) { return this.linkModel.findByIdAndDelete(id); }

  searchStickies(workspaceId, queryStr) {
    const searchRegex = { $regex: queryStr.trim(), $options: "i" };
    return this.model.find({ workspace: workspaceId, $or: [{ title: searchRegex }, { content: searchRegex }] })
      .limit(5)
      .select("title content color updatedAt");
  }
}



