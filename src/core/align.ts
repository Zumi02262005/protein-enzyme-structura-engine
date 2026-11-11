/**
 * Pairwise sequence alignment (Gotoh's affine-gap dynamic programming, with free end gaps so a
 * fragment can be laid against a full-length chain without penalty).
 */

const ORDER = 'ARNDCQEGHILKMFPSTWYV';

// BLOSUM62, rows and columns in the order above.
const BLOSUM62: number[][] = [
  [4, -1, -2, -2, 0, -1, -1, 0, -2, -1, -1, -1, -1, -2, -1, 1, 0, -3, -2, 0],
  [-1, 5, 0, -2, -3, 1, 0, -2, 0, -3, -2, 2, -1, -3, -2, -1, -1, -3, -2, -3],
  [-2, 0, 6, 1, -3, 0, 0, 0, 1, -3, -3, 0, -2, -3, -2, 1, 0, -4, -2, -3],
  [-2, -2, 1, 6, -3, 0, 2, -1, -1, -3, -4, -1, -3, -3, -1, 0, -1, -4, -3, -3],
  [0, -3, -3, -3, 9, -3, -4, -3, -3, -1, -1, -3, -1, -2, -3, -1, -1, -2, -2, -1],
  [-1, 1, 0, 0, -3, 5, 2, -2, 0, -3, -2, 1, 0, -3, -1, 0, -1, -2, -1, -2],
  [-1, 0, 0, 2, -4, 2, 5, -2, 0, -3, -3, 1, -2, -3, -1, 0, -1, -3, -2, -2],
  [0, -2, 0, -1, -3, -2, -2, 6, -2, -4, -4, -2, -3, -3, -2, 0, -2, -2, -3, -3],
  [-2, 0, 1, -1, -3, 0, 0, -2, 8, -3, -3, -1, -2, -1, -2, -1, -2, -2, 2, -3],
  [-1, -3, -3, -3, -1, -3, -3, -4, -3, 4, 2, -3, 1, 0, -3, -2, -1, -3, -1, 3],
  [-1, -2, -3, -4, -1, -2, -3, -4, -3, 2, 4, -2, 2, 0, -3, -2, -1, -2, -1, 1],
  [-1, 2, 0, -1, -3, 1, 1, -2, -1, -3, -2, 5, -1, -3, -1, 0, -1, -3, -2, -2],
  [-1, -1, -2, -3, -1, 0, -2, -3, -2, 1, 2, -1, 5, 0, -2, -1, -1, -1, -1, 1],
  [-2, -3, -3, -3, -2, -3, -3, -3, -1, 0, 0, -3, 0, 6, -4, -2, -2, 1, 3, -1],
  [-1, -2, -2, -1, -3, -1, -1, -2, -2, -3, -3, -1, -2, -4, 7, -1, -1, -4, -3, -2],
  [1, -1, 1, 0, -1, 0, 0, 0, -1, -2, -2, 0, -1, -2, -1, 4, 1, -3, -2, -2],
  [0, -1, 0, -1, -1, -1, -1, -2, -2, -1, -1, -1, -1, -2, -1, 1, 5, -2, -2, 0],
  [-3, -3, -4, -4, -2, -2, -3, -2, -2, -3, -2, -3, -1, 1, -4, -3, -2, 11, 2, -3],
  [-2, -2, -2, -3, -2, -1, -2, -3, 2, -1, -1, -2, -1, 3, -3, -2, -2, 2, 7, -1],
  [0, -3, -3, -3, -1, -2, -2, -3, -3, 3, 1, -2, 1, -1, -2, -2, 0, -3, -1, 4],
];

export { BLOSUM62, ORDER as BLOSUM_ORDER };

/** BLOSUM62 score for two one-letter amino acid codes (-1 when either is non-standard). */
export function substitutionScore(a: string, b: string): number {
  const i = ORDER.indexOf(a);
  const j = ORDER.indexOf(b);
  return i < 0 || j < 0 ? -1 : BLOSUM62[i][j];
}

export type Scoring = 'protein' | 'nucleic';

export interface Alignment {
  /** Aligned index pairs [position in a, position in b], in order. */
  pairs: Array<[number, number]>;
  /** Gapped strings of equal length ("-" marks a gap). */
  alignedA: string;
  alignedB: string;
  /** For every alignment column, the index into a / b, or -1 at a gap. */
  columnA: Int32Array;
  columnB: Int32Array;
  score: number;
  /** Identical aligned positions. */
  identical: number;
}

/** The largest dynamic-programming table we are willing to allocate (cells). */
export const MAX_ALIGNMENT_CELLS = 40_000_000;

function encode(seq: string, scoring: Scoring): Uint8Array {
  const out = new Uint8Array(seq.length);
  if (scoring === 'protein') {
    for (let i = 0; i < seq.length; i++) {
      const k = ORDER.indexOf(seq[i]);
      out[i] = k < 0 ? 20 : k;
    }
  } else {
    for (let i = 0; i < seq.length; i++) out[i] = seq.charCodeAt(i) & 0xff;
  }
  return out;
}

export function alignSequences(a: string, b: string, scoring: Scoring = 'protein'): Alignment {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) throw new Error('Both chains need at least one residue to align.');
  if ((n + 1) * (m + 1) > MAX_ALIGNMENT_CELLS) {
    throw new Error(`These chains are too long to align in the browser (${n} × ${m} residues).`);
  }
  const ea = encode(a, scoring);
  const eb = encode(b, scoring);
  const gapOpen = scoring === 'protein' ? -11 : -8; // cost of the first gap position
  const gapExtend = scoring === 'protein' ? -1 : -2;
  const sub = (x: number, y: number): number => {
    if (scoring === 'protein') return x === 20 || y === 20 ? -1 : BLOSUM62[x][y];
    return x === y ? 5 : -4;
  };

  const NEG = -1e9;
  const W = m + 1;
  // traceback bits: 0-1 = source of H (0 diagonal, 1 gap in a, 2 gap in b), 2 = E extended, 3 = F extended
  const trace = new Uint8Array((n + 1) * W);
  let prev = new Int32Array(W);
  let cur = new Int32Array(W);
  const F = new Int32Array(W).fill(NEG);

  let best = NEG;
  let bestI = n;
  let bestJ = m;

  for (let i = 1; i <= n; i++) {
    cur[0] = 0;
    let E = NEG;
    const ai = ea[i - 1];
    const rowOffset = i * W;
    for (let j = 1; j <= m; j++) {
      let bits = 0;
      // F: gap in b (consumes a residue of a)
      const fOpen = prev[j] + gapOpen;
      const fExt = F[j] + gapExtend;
      let f: number;
      if (fExt > fOpen) {
        f = fExt;
        bits |= 8;
      } else f = fOpen;
      F[j] = f;
      // E: gap in a (consumes a residue of b)
      const eOpen = cur[j - 1] + gapOpen;
      const eExt = E + gapExtend;
      if (eExt > eOpen) {
        E = eExt;
        bits |= 4;
      } else E = eOpen;

      let h = prev[j - 1] + sub(ai, eb[j - 1]);
      if (E > h) {
        h = E;
        bits = (bits & 12) | 1;
      }
      if (f > h) {
        h = f;
        bits = (bits & 12) | 2;
      }
      cur[j] = h;
      trace[rowOffset + j] = bits;
    }
    // free end gap: the alignment may end anywhere in the last column...
    if (cur[m] > best) {
      best = cur[m];
      bestI = i;
      bestJ = m;
    }
    if (i === n) {
      // ...or anywhere in the last row
      for (let j = 1; j <= m; j++) {
        if (cur[j] > best) {
          best = cur[j];
          bestI = n;
          bestJ = j;
        }
      }
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }

  // traceback
  const colA: number[] = [];
  const colB: number[] = [];
  for (let i = n - 1; i >= bestI; i--) {
    colA.push(i);
    colB.push(-1);
  }
  for (let j = m - 1; j >= bestJ; j--) {
    colA.push(-1);
    colB.push(j);
  }
  let i = bestI;
  let j = bestJ;
  let state = 0; // 0 = H, 1 = E, 2 = F
  while (i > 0 && j > 0) {
    const bits = trace[i * W + j];
    if (state === 0) {
      const source = bits & 3;
      if (source === 0) {
        colA.push(i - 1);
        colB.push(j - 1);
        i--;
        j--;
      } else state = source;
    } else if (state === 1) {
      colA.push(-1);
      colB.push(j - 1);
      if (!(bits & 4)) state = 0;
      j--;
    } else {
      colA.push(i - 1);
      colB.push(-1);
      if (!(bits & 8)) state = 0;
      i--;
    }
  }
  while (i > 0) {
    colA.push(--i);
    colB.push(-1);
  }
  while (j > 0) {
    colA.push(-1);
    colB.push(--j);
  }
  colA.reverse();
  colB.reverse();

  const pairs: Array<[number, number]> = [];
  let alignedA = '';
  let alignedB = '';
  let identical = 0;
  for (let k = 0; k < colA.length; k++) {
    const x = colA[k];
    const y = colB[k];
    alignedA += x >= 0 ? a[x] : '-';
    alignedB += y >= 0 ? b[y] : '-';
    if (x >= 0 && y >= 0) {
      pairs.push([x, y]);
      if (a[x] === b[y]) identical++;
    }
  }
  return { pairs, alignedA, alignedB, columnA: Int32Array.from(colA), columnB: Int32Array.from(colB), score: best, identical };
}
