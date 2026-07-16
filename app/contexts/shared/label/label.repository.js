import { LabelModel } from "./label.schema.js";

export class LabelRepository {
  constructor() {
    this.model = LabelModel;
  }
  find(filter) { return this.model.find(filter).populate("createdBy", "name avatar").sort({ name: 1 }); }
  findById(id) { return this.model.findById(id); }
  findByIdPopulated(id) { return this.model.findById(id).populate({ path: "workspace", populate: { path: "members.role" } }); }
  create(data) { return this.model.create(data); }
  deleteById(id) { return this.model.findOneAndDelete({ _id: id }); }
}



