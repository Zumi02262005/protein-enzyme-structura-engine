/** Shared data model for a parsed macromolecular structure. */

export type ResidueKind = 'protein' | 'nucleic' | 'water' | 'ion' | 'ligand';

/** Secondary structure code: 0 = coil, 1 = helix, 2 = strand. */
export type SS = 0 | 1 | 2;
export const SS_COIL: SS = 0;
export const SS_HELIX: SS = 1;
export const SS_STRAND: SS = 2;

export interface Residue {
  index: number;
  /** Index into `Structure.chains`. */
  chain: number;
  /** Three-letter component id, e.g. "ALA", "HEM", "HOH". */
  name: string;
  /** One-letter code for polymer residues ("X" when unknown, "" otherwise). */
  code: string;
  /** Author residue number (what papers and PDB files show). */
  seq: number;
  /** Position in the deposited sequence (label_seq_id), or -1 for non-polymers. */
  labelSeq: number;
  insCode: string;
  atomStart: number;
  /** Exclusive end index. */
  atomEnd: number;
  kind: ResidueKind;
  ss: SS;
  /** Atom index used for the backbone trace: Cα for protein, P (or C4') for nucleic, else -1. */
  trace: number;
  /** Backbone carbonyl oxygen atom index (protein only), else -1. */
  oxygen: number;
}

export type ChainKind = 'protein' | 'nucleic' | 'other';

export interface Chain {
  index: number;
  /** Author chain id (auth_asym_id): the familiar "A", "B", ... */
  id: string;
  /** Internal mmCIF chain id (label_asym_id), unique per molecule instance. */
  labelId: string;
  entityId: string;
  kind: ChainKind;
  residueStart: number;
  /** Exclusive end index. */
  residueEnd: number;
  /** One-letter sequence of the modelled polymer residues (empty for non-polymers). */
  sequence: string;
  /** Residue indices matching each letter of `sequence`. */
  sequenceResidues: number[];
}

export interface Structure {
  id: string;
  atomCount: number;
  /** Interleaved x, y, z coordinates in ångströms. */
  xyz: Float32Array;
  bfactor: Float32Array;
  /** Index into `ELEMENTS` (see chem.ts). */
  element: Uint8Array;
  atomName: string[];
  /** Residue index of every atom. */
  atomResidue: Int32Array;
  residues: Residue[];
  chains: Chain[];
  /** Number of models in the file. Only the first one is loaded. */
  modelCount: number;
  /** Where helix/strand assignments came from. */
  ssSource: 'file' | 'estimated' | 'none';
  /** Hydrogen atoms that were skipped while reading. */
  hydrogensSkipped: number;
}

export type Vec3 = [number, number, number];
