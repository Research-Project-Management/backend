import RoleModel from "./role.schema.js";

export class RoleRepository {
  constructor() {
    this.model = RoleModel;
  }
  findByWorkspace(workspaceId) {
    return this.model.find({ workspace: workspaceId, type: "workspace" })
      .populate("createdBy", "name email avatar")
      .sort({ isSystem: -1, name: 1 });
  }
  findById(id) { return this.model.findById(id).populate("createdBy", "name email avatar"); }
  findByWorkspaceAndName(workspaceId, name, excludeId = null) {
    const q = { workspace: workspaceId, name };
    if (excludeId) q._id = { $ne: excludeId };
    return this.model.findOne(q);
  }
  create(data) { return this.model.create(data); }
  insertMany(data) { return this.model.insertMany(data); }
  deleteById(id) { return this.model.findByIdAndDelete(id); }
}



