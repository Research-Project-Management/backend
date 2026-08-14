import { StickyModel } from "./sticky.schema.js";

export class StickyRepository {
  constructor() {
    this.model = StickyModel;
  }

  find(query) {
    return this.model.find(query).sort({ order: 1, createdAt: -1 });
  }

  findById(id) {
    return this.model.findById(id);
  }

  create(data) {
    return this.model.create(data);
  }

  updateById(id, data) {
    return this.model.findByIdAndUpdate(id, data, { new: true });
  }

  deleteById(id) {
    return this.model.findByIdAndDelete(id);
  }

  bulkReorder(operations) {
    return this.model.bulkWrite(operations);
  }

  searchStickies(scopeContext, queryStr) {
    const searchRegex = { $regex: queryStr.trim(), $options: "i" };
    return this.model
      .find({
        ...scopeContext,
        $or: [{ title: searchRegex }, { content: searchRegex }]
      })
      .limit(5)
      .select("title content color updatedAt");
  }
}

export class WorkspaceStickyRepository extends StickyRepository {
  constructor() {
    super();
  }
}

export class ProjectStickyRepository extends StickyRepository {
  constructor() {
    super();
  }
}
