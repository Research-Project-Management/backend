export function calculateCompleteness(
  present: string[],
  missing: string[],
): number {
  const total = present.length + missing.length;
  if (total === 0) return 100;
  return Math.round((present.length / total) * 100);
}
