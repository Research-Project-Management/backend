import { PdfAnnotation } from '../types/annotations.types';

export function groupAnnotationsByPage(
  annotations: PdfAnnotation[],
): Map<number, PdfAnnotation[]> {
  const sorted = [...annotations].sort((a, b) => a.pageNumber - b.pageNumber);
  const pageMap = new Map<number, PdfAnnotation[]>();
  for (const ann of sorted) {
    const list = pageMap.get(ann.pageNumber) || [];
    list.push(ann);
    pageMap.set(ann.pageNumber, list);
  }
  return pageMap;
}
