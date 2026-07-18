export const getPaginationOptions = (req, defaultLimit = 10, defaultSort = "-createdAt") => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(1, parseInt(req.query.limit, 10) || defaultLimit);
  const skip = (page - 1) * limit;
  const sort = req.query.sort || defaultSort;

  return { page, limit, skip, sort };
};

export const buildPaginatedResponse = (data, totalItems, page, limit) => {
  const totalPages = Math.ceil(totalItems / limit);
  return {
    data,
    meta: {
      total: totalItems,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
    }
  };
};
