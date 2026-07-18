import CycleModel from "./cycle.schema.js";

export class CycleRepository {
  constructor() {
    this.model = CycleModel;
  }
  findByProject(id) { return this.model.find({ projectId: id }).sort({ createdAt: -1 }); }
  findById(id) { return this.model.findById(id); }
  findOne(query) { return this.model.findOne(query); }
  create(data) { return this.model.create(data); }
  updateById(id, data) { return this.model.findByIdAndUpdate(id, data, { new: true }); }
  deleteById(id) { return this.model.findByIdAndDelete(id); }
}



