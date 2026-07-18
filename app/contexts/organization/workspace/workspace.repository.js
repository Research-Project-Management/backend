import WorkspaceModel from "./workspace.schema.js";

export class WorkspaceRepository {
  constructor() {
    this.model = WorkspaceModel;
  }
  findByMember(userId) { return this.model.find({ "members.userId": userId }); }
  findById(id) { return this.model.findById(id); }
  findByIdPopulated(id) {
    return this.model.findById(id);
  }
  findByInviteCode(code) { return this.model.findOne({ inviteCode: code }); }
  create(data) { return this.model.create(data); }
  updateById(id, updates) { return this.model.findByIdAndUpdate(id, updates, { new: true }); }
  deleteById(id) { return this.model.findByIdAndDelete(id); }
  findByUrl(url) { return this.model.findOne({ url }).lean(); }
}



