import UserModel from "./auth.schema.js";

export class AuthRepository {
  constructor() {
    this.model = UserModel;
  }
  findByEmail(email) { return this.model.findOne({ email }); }
  findById(id) { return this.model.findById(id).select("+password"); }
  findByIdSelect(id, select) { return this.model.findById(id).select(select).lean(); }
  create(data) { return this.model.create(data); }
  updateById(id, updates) { return this.model.findByIdAndUpdate(id, updates, { new: true }).select("-password"); }
  searchByNameOrEmail(query, excludeId) {
    return this.model.find({
      $or: [{ email: { $regex: query, $options: "i" } }, { name: { $regex: query, $options: "i" } }],
      _id: { $ne: excludeId },
    }).select("name email avatar").limit(10);
  }
}



