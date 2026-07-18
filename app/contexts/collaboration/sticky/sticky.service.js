import { AppError } from "../../../lib/AppError.js";

export class StickyService {
  constructor({ stickyRepository }) {
    this.repo = stickyRepository;
  }

  _parseLabelQuery(labels) {
    if (!labels) return [];
    const values = Array.isArray(labels) ? labels : [labels];
    return values.flatMap((v) => String(v).split(",")).map((v) => v.trim()).filter(Boolean);
  }

  async getWorkspaceStickies(workspaceId, userId, { labels, scope, category, projectId }) {
    const query = { workspaceId: workspaceId, authorId: userId };
    const labelIds = this._parseLabelQuery(labels);
    if (labelIds.length > 0) query.labels = { $in: labelIds };
    const hasProjectFilter = projectId && projectId !== "null" && projectId !== "undefined" && projectId !== "";
    if (scope === "project") query.projectId = { $ne: null };
    else if (scope === "workspace" || category === "sticky") query.projectId = null;
    else if (category === "note") query.projectId = { $ne: null };
    if (hasProjectFilter) {
      query.projectId = projectId;
    } else if (projectId === "null") { query.projectId = null; }
    return this.repo.find(query);
  }

  async getProjectStickies(projectId, userId, { labels }) {
    const query = { projectId, authorId: userId };
    const labelIds = this._parseLabelQuery(labels);
    if (labelIds.length > 0) query.labels = { $in: labelIds };
    return this.repo.find(query);
  }

  async createSticky(workspaceId, { title, content, color, labels, position, projectId, parentStickyId }, userId) {
    const isProjectSticky = Boolean(projectId);
    const sticky = await this.repo.create({ title: title || "", content: content || "<p></p>", color: color || "yellow-1", labels: labels || [], position: position || { x: 0, y: 0 }, workspaceId: workspaceId, authorId: userId, scope: isProjectSticky ? "project" : "workspace", category: "sticky", projectId: isProjectSticky ? projectId : null });
    if (isProjectSticky && parentStickyId) {
      await this.repo.upsertLink(sticky._id, userId, { workspaceId: workspaceId, parentStickyId: parentStickyId, childStickyId: sticky._id, projectId: projectId, authorId: userId });
    }
    return sticky;
  }

  async updateSticky(stickyId, updates, userId) {
    const sticky = await this.repo.findById(stickyId);
    if (!sticky) throw new AppError("Sticky not found", 404);
    if (sticky.authorId !== userId.toString()) throw new AppError("Access denied", 403);
    const { title, content, color, labels, position, projectId } = updates;
    const updateData = Object.fromEntries(Object.entries({ title, content, color, labels, position, projectId }).filter(([, v]) => v !== undefined));
    updateData.scope = sticky.projectId || projectId ? "project" : "workspace";
    return this.repo.updateById(stickyId, updateData);
  }

  async deleteSticky(stickyId, userId) {
    const sticky = await this.repo.findById(stickyId);
    if (!sticky) throw new AppError("Sticky not found", 404);
    if (sticky.authorId !== userId.toString()) throw new AppError("Access denied", 403);
    await this.repo.deleteById(stickyId);
    await this.repo.deleteLinks({ $or: [{ childStickyId: sticky._id }, { childNoteId: sticky._id }, { parentStickyId: sticky._id }], authorId: userId });
  }

  async reorder(stickyIds, userId, scope, scopeId) {
    if (!Array.isArray(stickyIds)) throw new AppError("stickyIds must be an array", 400);
    const ops = stickyIds.map((id, index) => ({ updateOne: { filter: { _id: id, authorId: userId, ...(scope === "workspace" ? { workspaceId: scopeId } : { projectId: scopeId }) }, update: { $set: { order: index } } } }));
    if (ops.length > 0) await this.repo.bulkReorder(ops);
  }

  async getChildren(stickyId, userId) {
    const parent = await this.repo.findById(stickyId);
    if (!parent) throw new AppError("Parent sticky not found", 404);
    if (parent.authorId !== userId.toString()) throw new AppError("Access denied", 403);
    const links = await this.repo.findLinks(stickyId, userId);
    return links.map((link) => ({ ...link.toObject(), sticky: link.childStickyId || link.childNoteId }));
  }

  async addChild(stickyId, { childStickyId, childNoteId }, userId) {
    const resolvedId = childStickyId || childNoteId;
    const [parentSticky, childSticky] = await Promise.all([this.repo.findById(stickyId), this.repo.findById(resolvedId)]);
    if (!parentSticky) throw new AppError("Parent sticky not found", 404);
    if (!childSticky?.projectId) throw new AppError("Child sticky not found", 404);
    if (parentSticky.authorId !== userId.toString() || childSticky.authorId !== userId.toString()) throw new AppError("Access denied", 403);
    const link = await this.repo.upsertLink(childSticky._id, userId, { workspaceId: parentSticky.workspaceId, parentStickyId: parentSticky._id, childStickyId: childSticky._id, projectId: childSticky.projectId, authorId: userId });
    return { link: { ...link.toObject(), sticky: link.childStickyId || link.childNoteId } };
  }

  async removeChild(stickyId, childStickyId, userId) {
    const link = await this.repo.findLink(stickyId, childStickyId, userId);
    if (!link) throw new AppError("Link not found or no access", 404);
    await this.repo.deleteLinkById(link._id);
  }
}




