import { LabelModel } from "./label.schema.js";

export class LabelRepository {
  constructor() {
    this.model = LabelModel;
  }
  find(filter) { return this.model.find(filter).sort({ name: 1 }); }
  findById(id) { return this.model.findById(id); }
  findByIdPopulated(id) { return this.model.findById(id); }
  create(data) { return this.model.create(data); }
  deleteById(id) { return this.model.findOneAndDelete({ _id: id }); }
}



