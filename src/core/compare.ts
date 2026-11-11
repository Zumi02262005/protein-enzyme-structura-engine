/**
 * Structure comparison pipeline: align two chains by sequence, superpose their matched backbone
 * atoms, and report how well they agree.
 */
import { alignSequences, MAX_ALIGNMENT_CELLS, type Alignment } from './align';
import { applyTransform, superpose, type RigidTransform } from './superpose';
import type { Chain, Structure } from './types';

export interface ChainComparison {
  chainA: number;
  chainB: number;
  alignment: Alignment;
  /** Transform that moves structure B onto structure A. */
  transform: RigidTransform;
  /** Residues matched by the alignment (and present in both models). */
  matched: number;
  /** Matched pairs kept after outlier rejection. */
  coreCount: number;
  rmsdCore: number;
  rmsdAll: number;
  /** Identical residues ÷ matched residues. */
  identity: number;
  /** Matched residues ÷ length of the shorter chain. */
  coverage: number;
  /** TM-score of this superposition, normalised by the shorter chain. */
  tmScore: number;
  /** Per alignment column: Cα–Cα (or P–P) distance in Å, or -1 where there is a gap. */
  columnDistance: Float32Array;
  /** Residue index (in structure A) → distance to its partner, for colouring. */
  distanceA: Map<number, number>;
  /** Residue index (in structure B) → distance to its partner. */
  distanceB: Map<number, number>;
}

/** Polymer chains that can take part in a comparison. */
export function comparableChains(s: Structure): Chain[] {
  return s.chains.filter((c) => c.kind !== 'other' && c.sequence.length >= 3);
}

function tracePoints(s: Structure, residueIndices: number[]): Float64Array {
  const out = new Float64Array(residueIndices.length * 3);
  residueIndices.forEach((r, k) => {
    const atom = s.residues[r].trace;
    out[k * 3] = s.xyz[atom * 3];
    out[k * 3 + 1] = s.xyz[atom * 3 + 1];
    out[k * 3 + 2] = s.xyz[atom * 3 + 2];
  });
  return out;
}

export function compareChains(a: Structure, chainA: number, b: Structure, chainB: number): ChainComparison {
  const ca = a.chains[chainA];
  const cb = b.chains[chainB];
  if (!ca || !cb) throw new Error('Choose a chain from each structure.');
  if (ca.kind === 'other' || cb.kind === 'other') throw new Error('Only protein and nucleic acid chains can be compared.');
  if (ca.kind !== cb.kind) throw new Error('A protein chain cannot be compared with a nucleic acid chain.');

  const alignment = alignSequences(ca.sequence, cb.sequence, ca.kind === 'protein' ? 'protein' : 'nucleic');
  const resA = alignment.pairs.map(([i]) => ca.sequenceResidues[i]);
  const resB = alignment.pairs.map(([, j]) => cb.sequenceResidues[j]);
  const matched = alignment.pairs.length;
  if (matched < 3) throw new Error('These chains share too few matching residues to superpose.');

  const target = tracePoints(a, resA);
  const mobile = tracePoints(b, resB);
  const fit = superpose(mobile, target);

  const shorter = Math.min(ca.sequence.length, cb.sequence.length);
  const d0 = Math.max(0.5, 1.24 * Math.cbrt(Math.max(shorter - 15, 1)) - 1.8);
  let tmSum = 0;
  for (let k = 0; k < matched; k++) tmSum += 1 / (1 + (fit.distances[k] / d0) ** 2);

  const columnDistance = new Float32Array(alignment.columnA.length).fill(-1);
  const distanceA = new Map<number, number>();
  const distanceB = new Map<number, number>();
  let pair = 0;
  for (let col = 0; col < alignment.columnA.length; col++) {
    if (alignment.columnA[col] >= 0 && alignment.columnB[col] >= 0) {
      const d = fit.distances[pair];
      columnDistance[col] = d;
      distanceA.set(resA[pair], d);
      distanceB.set(resB[pair], d);
      pair++;
    }
  }

  return {
    chainA,
    chainB,
    alignment,
    transform: fit.transform,
    matched,
    coreCount: fit.core.length,
    rmsdCore: fit.rmsdCore,
    rmsdAll: fit.rmsdAll,
    identity: alignment.identical / matched,
    coverage: matched / shorter,
    tmScore: tmSum / shorter,
    columnDistance,
    distanceA,
    distanceB,
  };
}

/**
 * Pick the pair of chains (one from each structure) whose sequences match best. Identical chains
 * inside one entry are only tried once. Pass `fixedA` / `fixedB` (chain indices) to hold one side
 * still and only search for its best partner.
 */
export function bestChainPair(a: Structure, b: Structure, fixedA?: number, fixedB?: number): [number, number] | null {
  const candidates = (s: Structure, fixed: number | undefined): Chain[] => {
    if (fixed !== undefined) return s.chains[fixed] ? [s.chains[fixed]] : [];
    const seen = new Set<string>();
    return comparableChains(s)
      .filter((c) => {
        const key = c.kind + ':' + c.sequence;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 8);
  };
  const listA = candidates(a, fixedA);
  const listB = candidates(b, fixedB);
  let best: [number, number] | null = null;
  let bestScore = -Infinity;
  for (const x of listA) {
    for (const y of listB) {
      if (x.kind !== y.kind || x.kind === 'other') continue;
      if ((x.sequence.length + 1) * (y.sequence.length + 1) > MAX_ALIGNMENT_CELLS / 4) continue;
      const al = alignSequences(x.sequence, y.sequence, x.kind === 'protein' ? 'protein' : 'nucleic');
      // favour long, high-identity matches
      const score = al.identical - 0.25 * (Math.min(x.sequence.length, y.sequence.length) - al.pairs.length);
      if (score > bestScore) {
        bestScore = score;
        best = [x.index, y.index];
      }
    }
  }
  if (!best) {
    // nothing could be aligned (for example, very long chains): fall back to the first compatible pair
    const x = listA[0];
    const y = x ? listB.find((c) => c.kind === x.kind) : undefined;
    if (x && y) best = [x.index, y.index];
  }
  return best;
}

/** A copy of `s` with every atom moved by `t`. */
export function transformStructure(s: Structure, t: RigidTransform): Structure {
  return { ...s, xyz: applyTransform(s.xyz, t) };
}
