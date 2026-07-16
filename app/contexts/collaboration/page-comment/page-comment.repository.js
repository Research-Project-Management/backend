import PageCommentModel from "./page-comment.schema.js";

export class PageCommentRepository {
  constructor() {
    this.model = PageCommentModel;
  }
  find(filter) { return this.model.find(filter).sort({ createdAt: -1 }).limit(200); }
  findById(id) { return this.model.findById(id); }
  findOne(id, pageId) { return this.model.findOne({ _id: id, page: pageId }); }
  create(data) { return this.model.create(data); }
}



