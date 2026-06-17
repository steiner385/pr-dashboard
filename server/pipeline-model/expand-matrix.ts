import type { MatrixCoord, RawJob } from './types';

/** Cartesian product of the matrix dimensions. No matrix → one empty coordinate. */
export function expandMatrix(matrix: RawJob['matrix']): MatrixCoord[] {
  if (!matrix) return [{}];
  let acc: MatrixCoord[] = [{}];
  for (const [dim, values] of Object.entries(matrix)) {
    const next: MatrixCoord[] = [];
    for (const coord of acc) for (const v of values) next.push({ ...coord, [dim]: v });
    acc = next;
  }
  return acc.length ? acc : [{}];
}
