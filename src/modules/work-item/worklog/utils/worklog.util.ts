import { WorklogPaginationResult } from '../types/worklog.types';

export { WorklogPaginationResult };

export const calculateTotalWorklogHours = (
  items: Array<{ hours?: number | null }>,
): number => {
  return items.reduce((sum, log) => sum + (log.hours || 0), 0);
};

export const normalizePagination = (
  page?: number,
  limit?: number,
  defaultLimit = 50,
  maxLimit = 200,
) => {
  const normalizedPage = Math.max(1, page ?? 1);
  const normalizedLimit = Math.min(
    maxLimit,
    Math.max(1, limit ?? defaultLimit),
  );
  const offset = (normalizedPage - 1) * normalizedLimit;
  return {
    page: normalizedPage,
    limit: normalizedLimit,
    offset,
  };
};
