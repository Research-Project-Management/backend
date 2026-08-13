import FileModel from './file.schema.js';

/**
 * Base Repository layer for File entity.
 */
export class FileRepository {
  constructor() {
    this.model = FileModel;
  }

  /**
   * Finds a file by its ID.
   * @param {string} fileId - The ID of the file.
   * @returns {Promise<Object>} The file document.
   */
  findById(fileId) {
    return this.model.findById(fileId);
  }

  /**
   * Finds a file by its ID and returns a plain JavaScript object.
   * @param {string} fileId - The ID of the file.
   * @returns {Promise<Object>} The plain file object.
   */
  findOneById(fileId) {
    return this.model.findById(fileId).lean();
  }

  /**
   * Finds a single file matching the given filter.
   * @param {Object} filter - The MongoDB filter object.
   * @returns {Promise<Object>} The file document.
   */
  findOne(filter) {
    return this.model.findOne(filter);
  }

  /**
   * Creates a new file record.
   * @param {Object} data - The data to create the file.
   * @returns {Promise<Object>} The created file document.
   */
  create(data) {
    return this.model.create(data);
  }

  /**
   * Saves an existing file document.
   * @param {Object} doc - The Mongoose document to save.
   * @returns {Promise<Object>} The saved document.
   */
  save(doc) {
    return doc.save();
  }

  /**
   * Updates a file by its ID.
   * @param {string} fileId - The ID of the file.
   * @param {Object} data - The update payload.
   * @returns {Promise<Object>} The updated file document.
   */
  updateById(fileId, data) {
    return this.model.findByIdAndUpdate(fileId, data, { new: true });
  }

  /**
   * Deletes a file by its ID.
   * @param {string} fileId - The ID of the file.
   * @returns {Promise<Object>} The deleted file document.
   */
  deleteById(fileId) {
    return this.model.findByIdAndDelete(fileId);
  }

  /**
   * Finds all children files/folders of a given parent folder.
   * @param {string} parentId - The ID of the parent folder.
   * @returns {Promise<Array>} List of children files.
   */
  findChildren(parentId) {
    return this.model.find({ parent: parentId });
  }

  /**
   * Updates all children of a given parent folder.
   * @param {string} parentId - The ID of the parent folder.
   * @param {Object} updates - The update payload.
   * @returns {Promise<Object>} The update result.
   */
  updateManyByParent(parentId, updates) {
    return this.model.updateMany({ parent: parentId }, updates);
  }

  /**
   * Deletes all children of a given parent folder.
   * @param {string} parentId - The ID of the parent folder.
   * @returns {Promise<Object>} The deletion result.
   */
  deleteManyByParent(parentId) {
    return this.model.deleteMany({ parent: parentId });
  }

  /**
   * Base method meant to be overridden by child classes (Polymorphism).
   * Determines the database filter structure for the current scope.
   */
  getScopeFilter(entityId) {
    return {};
  }

  /**
   * Finds files dynamically utilizing the scoped filter and extra queries.
   * @param {string} entityId - The scope ID (workspaceId, projectId, etc.)
   * @param {Object} filters - Query filters (isTrashed, parentId, authorId, starred, sharedWithUserId)
   * @returns {Promise<Array>} List of files matching criteria.
   */
  getFiles(entityId, filters = {}) {
    const query = { ...this.getScopeFilter(entityId) };

    if (filters.isTrashed) {
      query.trashedAt = { $ne: null };
    } else {
      query.trashedAt = null;
    }

    if (filters.parentId !== undefined) {
      query.parent = filters.parentId || null;
    }
    if (filters.authorId) {
      query.authorId = filters.authorId;
    }
    if (filters.starred) {
      query.starred = true;
    }
    if (filters.sharedWithUserId) {
      query['sharedWith.userId'] = filters.sharedWithUserId;
    }

    return this.model
      .find(query)
      .populate('author', 'name email avatar')
      .sort({ isFolder: -1, filename: 1 });
  }

  /**
   * Counts active files in the current scope.
   */
  countFiles(entityId) {
    return this.model.countDocuments({
      ...this.getScopeFilter(entityId),
      trashedAt: null,
    });
  }

  /**
   * Finds all active files in the current scope without pagination.
   */
  findAllActive(entityId) {
    return this.model
      .find({ ...this.getScopeFilter(entityId), trashedAt: null })
      .sort({ createdAt: -1 });
  }

  findRecentFiles(workspaceId, limit = 10) {
    return this.model
      .find({ workspaceId, trashedAt: null })
      .populate('author', 'name email avatar')
      .sort({ updatedAt: -1 })
      .limit(limit);
  }

  searchFiles(workspaceId, accessibleProjectIds, queryStr) {
    const searchRegex = { $regex: queryStr.trim(), $options: 'i' };

    return this.model
      .find({
        workspaceId,
        $or: [
          {
            'linkedTo.entityType': 'Project',
            'linkedTo.entityId': { $in: accessibleProjectIds },
          },
          { 'linkedTo.entityType': null },
        ],
        filename: searchRegex,
        trashedAt: null,
      })
      .limit(5)
      .select('filename mimeType size updatedAt linkedTo isFolder');
  }
}

export class WorkspaceFileRepository extends FileRepository {
  getScopeFilter(workspaceId) {
    return { workspaceId, 'linkedTo.entityType': null };
  }
}

export class ProjectFileRepository extends FileRepository {
  getScopeFilter(projectId) {
    return { 'linkedTo.entityType': 'Project', 'linkedTo.entityId': projectId };
  }
}

export class PageFileRepository extends FileRepository {
  getScopeFilter(pageId) {
    return { 'linkedTo.entityType': 'Page', 'linkedTo.entityId': pageId };
  }

  findByPageId(pageId) { 
    return this.model.find({ ...this.getScopeFilter(pageId), trashedAt: null, isFolder: false, url: { $exists: true, $ne: null } }).lean(); 
  }
}
