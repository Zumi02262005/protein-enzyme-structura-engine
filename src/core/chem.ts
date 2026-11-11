/** Element and residue tables. */

export interface ElementInfo {
  symbol: string;
  /** van der Waals radius, Å. */
  vdw: number;
  /** Covalent radius, Å (used to infer bonds). */
  covalent: number;
  /** Display colour, 0–255 RGB. */
  color: [number, number, number];
}

const el = (symbol: string, vdw: number, covalent: number, hex: string): ElementInfo => ({
  symbol,
  vdw,
  covalent,
  color: [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)],
});

/** Index 0 is the fallback for anything not listed. Colours are tuned to sit inside the app palette. */
export const ELEMENTS: ElementInfo[] = [
  el('X', 1.8, 0.77, '#c7a7d8'),
  el('C', 1.7, 0.76, '#b9c9be'),
  el('N', 1.55, 0.71, '#6f9fd8'),
  el('O', 1.52, 0.66, '#e2766c'),
  el('S', 1.8, 1.05, '#e8cd5e'),
  el('P', 1.8, 1.07, '#e59b52'),
  el('H', 1.1, 0.31, '#eef3f4'),
  el('FE', 1.94, 1.32, '#d98a5a'),
  el('ZN', 1.39, 1.22, '#8f9fc4'),
  el('MG', 1.73, 1.41, '#9ad27a'),
  el('CA', 2.31, 1.76, '#8fd0a0'),
  el('NA', 2.27, 1.66, '#b38ad8'),
  el('K', 2.75, 2.03, '#a37bd0'),
  el('CL', 1.75, 1.02, '#77d48c'),
  el('MN', 1.97, 1.39, '#b58cc9'),
  el('CU', 1.4, 1.32, '#d89a66'),
  el('CO', 1.92, 1.26, '#e59fb0'),
  el('NI', 1.63, 1.24, '#7fcf8c'),
  el('SE', 1.9, 1.2, '#e8ad4f'),
  el('F', 1.47, 0.57, '#a8e0a0'),
  el('BR', 1.85, 1.2, '#b5694f'),
  el('I', 1.98, 1.39, '#a070b8'),
  el('CD', 1.58, 1.44, '#e6d08f'),
  el('HG', 1.55, 1.32, '#b9b9cc'),
  el('MO', 2.17, 1.54, '#6fbcb5'),
  el('W', 2.1, 1.62, '#5f9fc9'),
  el('B', 1.92, 0.84, '#f0b8b4'),
  el('SI', 2.1, 1.11, '#e3c9a0'),
  el('AS', 1.85, 1.19, '#c08ae0'),
  el('D', 1.1, 0.31, '#eef3f4'),
];

const ELEMENT_INDEX = new Map<string, number>(ELEMENTS.map((e, i) => [e.symbol, i]));

export const EL_C = 1;
export const EL_H = 6;
export const EL_D = ELEMENT_INDEX.get('D')!;

export function elementIndex(symbol: string): number {
  return ELEMENT_INDEX.get(symbol.toUpperCase()) ?? 0;
}

const AMINO: Record<string, string> = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E', GLY: 'G', HIS: 'H', ILE: 'I',
  LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P', SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V',
  // Common modified residues mapped to their parent
  MSE: 'M', SEC: 'U', PYL: 'O', SEP: 'S', TPO: 'T', PTR: 'Y', HYP: 'P', CSO: 'C', CME: 'C', MLY: 'K',
  KCX: 'K', LLP: 'K', PCA: 'E', CSD: 'C', OCS: 'C', M3L: 'K', ALY: 'K', HIC: 'H', NLE: 'L', ABA: 'A',
};

const NUCLEOTIDE: Record<string, string> = {
  A: 'A', C: 'C', G: 'G', U: 'U', T: 'T', I: 'I', N: 'N',
  DA: 'A', DC: 'C', DG: 'G', DT: 'T', DU: 'U', DI: 'I', DN: 'N',
  PSU: 'U', '5MC': 'C', '5MU': 'U', H2U: 'U', '1MA': 'A', '2MG': 'G', '7MG': 'G', M2G: 'G', OMC: 'C', OMG: 'G',
};

export function aminoCode(name: string): string {
  return AMINO[name] ?? 'X';
}

export function nucleotideCode(name: string): string {
  return NUCLEOTIDE[name] ?? 'N';
}

/** True for purine-like bases, where the Watson–Crick edge atom is N1 (N3 for pyrimidines). */
export function isPurine(name: string): boolean {
  const c = NUCLEOTIDE[name];
  return c === 'A' || c === 'G' || c === 'I';
}

export const WATER_NAMES = new Set(['HOH', 'DOD', 'WAT', 'H2O']);
