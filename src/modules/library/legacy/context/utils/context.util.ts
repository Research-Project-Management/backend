export function formatContextSummary(
  title: string,
  totalAnnotations: number,
  totalRelations: number,
): string {
  return `${title} (${totalAnnotations} annotations, ${totalRelations} related items)`;
}
