/**
 * Turns parsed structures plus display options into GPU-ready buffers: a ribbon mesh, sphere and
 * cylinder instances, and the points used for mouse picking.
 */
import { EL_C, ELEMENTS, isPurine } from '../core/chem';
import type { Chain, Residue, Structure, Vec3 } from '../core/types';
import { SS_HELIX, SS_STRAND } from '../core/types';
import { InstanceBuilder, MeshBuilder, extrudeRibbon, findBonds, type InstanceData, type MeshData, type Profile, type RibbonDetail, type TraceResidue } from './geometry';
import { cross, dot, normalize, perpendicular, sub } from './math';
import { BFACTOR, CHAIN_COLORS, LIGAND_CARBON, RAINBOW, SS_COLORS, UNMATCHED, deviationColor, ramp, type RGB } from './palette';

export type PolymerStyle = 'cartoon' | 'tube' | 'sticks' | 'spheres';
export type ColorMode = 'chain' | 'secondary' | 'rainbow' | 'bfactor' | 'uniform' | 'deviation';

export interface Layer {
  structure: Structure;
  style: PolymerStyle;
  color: ColorMode;
  /** Base colour for the 'uniform' and 'deviation' modes. */
  baseColor?: RGB;
  /** Residue index → distance to its matched partner, for the 'deviation' mode. */
  deviation?: Map<number, number>;
  /** Chain indices to leave out. */
  hiddenChains?: Set<number>;
  /** When set, only these chain indices are drawn. */
  onlyChains?: Set<number>;
  showLigands: boolean;
  showWater: boolean;
}

export interface PickData {
  xyz: Float32Array;
  radius: Float32Array;
  /** Atom index inside its layer's structure. */
  atom: Int32Array;
  /** Which layer the atom belongs to. */
  layer: Uint8Array;
  count: number;
}

export interface SceneData {
  mesh: MeshData | null;
  spheres: InstanceData;
  cylinders: InstanceData;
  pick: PickData;
  center: Vec3;
  radius: number;
  /** True when nothing at all is visible. */
  empty: boolean;
}

const HELIX: Profile = { w: 0.95, h: 0.22, e: 3 };
const SHEET: Profile = { w: 0.88, h: 0.2, e: 6 };
const COIL: Profile = { w: 0.22, h: 0.22, e: 2 };
const NUCLEIC: Profile = { w: 0.42, h: 0.42, e: 2 };
const TUBE: Profile = { w: 0.32, h: 0.32, e: 2 };

function ribbonDetail(residueCount: number): RibbonDetail {
  if (residueCount <= 1500) return { subdivisions: 8, sides: 12 };
  if (residueCount <= 6000) return { subdivisions: 6, sides: 10 };
  if (residueCount <= 20000) return { subdivisions: 4, sides: 8 };
  return { subdivisions: 3, sides: 6 };
}

const atomPos = (s: Structure, atom: number): Vec3 => [s.xyz[atom * 3], s.xyz[atom * 3 + 1], s.xyz[atom * 3 + 2]];

function findAtom(s: Structure, r: Residue, name: string): number {
  for (let a = r.atomStart; a < r.atomEnd; a++) if (s.atomName[a] === name) return a;
  return -1;
}

/** The colour each chain gets in 'chain' mode, indexed like `structure.chains`. */
export function chainColors(s: Structure): RGB[] {
  // number polymer chains first so their colours do not depend on how many ligands precede them
  const slot = new Int32Array(s.chains.length);
  let k = 0;
  for (const c of s.chains) if (c.kind !== 'other') slot[c.index] = k++;
  const byAuth = new Map<string, number>();
  for (const c of s.chains) if (c.kind !== 'other' && !byAuth.has(c.id)) byAuth.set(c.id, slot[c.index]);
  for (const c of s.chains) if (c.kind === 'other') slot[c.index] = byAuth.get(c.id) ?? k++;
  return s.chains.map((c) => CHAIN_COLORS[slot[c.index] % CHAIN_COLORS.length]);
}

/** Per-residue colour function for a layer. */
function residueColorizer(layer: Layer): (r: Residue) => RGB {
  const s = layer.structure;
  const base = layer.baseColor ?? CHAIN_COLORS[0];
  switch (layer.color) {
    case 'uniform':
      return () => base;
    case 'deviation': {
      const dev = layer.deviation;
      return (r) => {
        const d = dev?.get(r.index);
        return d === undefined ? UNMATCHED : deviationColor(base, d);
      };
    }
    case 'secondary':
      return (r) => (r.kind === 'nucleic' ? SS_COLORS.nucleic : r.ss === SS_HELIX ? SS_COLORS.helix : r.ss === SS_STRAND ? SS_COLORS.strand : SS_COLORS.coil);
    case 'rainbow': {
      // position along each polymer chain, N-terminus to C-terminus
      const fraction = new Float32Array(s.residues.length);
      for (const c of s.chains) {
        const n = c.residueEnd - c.residueStart;
        for (let i = 0; i < n; i++) fraction[c.residueStart + i] = n > 1 ? i / (n - 1) : 0.5;
      }
      return (r) => ramp(RAINBOW, fraction[r.index]);
    }
    case 'bfactor': {
      // scale between the 5th and 95th percentile so a few extreme atoms do not flatten the range
      const sample: number[] = [];
      const step = Math.max(1, Math.floor(s.atomCount / 20000));
      for (let a = 0; a < s.atomCount; a += step) sample.push(s.bfactor[a]);
      sample.sort((x, y) => x - y);
      const lo = sample[Math.floor(sample.length * 0.05)] ?? 0;
      const hi = sample[Math.floor(sample.length * 0.95)] ?? 1;
      const span = hi - lo > 1e-6 ? hi - lo : 1;
      return (r) => {
        const atom = r.trace >= 0 ? r.trace : r.atomStart;
        return ramp(BFACTOR, (s.bfactor[atom] - lo) / span);
      };
    }
    case 'chain':
    default: {
      const colors = chainColors(s);
      return (r) => colors[r.chain];
    }
  }
}

function chainVisible(layer: Layer, chain: Chain, polymerAuthVisible: Set<string>): boolean {
  if (layer.onlyChains) {
    if (chain.kind !== 'other') return layer.onlyChains.has(chain.index);
    return polymerAuthVisible.has(chain.id);
  }
  if (layer.hiddenChains?.has(chain.index)) return false;
  // ligands and waters follow the polymer chain they are assigned to
  if (chain.kind === 'other' && layer.hiddenChains && layer.hiddenChains.size > 0) {
    const s = layer.structure;
    const owners = s.chains.filter((c) => c.kind !== 'other' && c.id === chain.id);
    if (owners.length > 0 && owners.every((c) => layer.hiddenChains!.has(c.index))) return false;
  }
  return true;
}

/** Build the ribbon for one polymer chain. */
function addRibbon(mesh: MeshBuilder, cylinders: InstanceBuilder, spheres: InstanceBuilder, layer: Layer, chain: Chain, colorOf: (r: Residue) => RGB, detail: RibbonDetail): void {
  const s = layer.structure;
  const tube = layer.style === 'tube';
  const list: Residue[] = [];
  for (let i = chain.residueStart; i < chain.residueEnd; i++) {
    const r = s.residues[i];
    if (r.trace >= 0 && r.kind === chain.kind) list.push(r);
  }
  if (list.length === 0) return;
  const maxGap = chain.kind === 'protein' ? 4.6 : 8.2;

  let begin = 0;
  while (begin < list.length) {
    // one continuous stretch: stop where consecutive trace atoms are too far apart (missing residues)
    let end = begin + 1;
    while (end < list.length) {
      const a = atomPos(s, list[end - 1].trace);
      const b = atomPos(s, list[end].trace);
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > maxGap) break;
      end++;
    }
    const seg = list.slice(begin, end);
    begin = end;
    const m = seg.length;
    if (m === 1) {
      const r = seg[0];
      spheres.push([...atomPos(s, r.trace), tube ? TUBE.w : chain.kind === 'nucleic' ? NUCLEIC.w : 0.4], colorOf(r));
      continue;
    }

    const raw = seg.map((r) => atomPos(s, r.trace));
    const ss = seg.map((r) => (tube || chain.kind !== 'protein' ? 0 : r.ss));
    // strands of a single residue cannot carry an arrow: draw them as coil
    for (let i = 0; i < m; i++) {
      if (ss[i] === SS_STRAND && (i === 0 || ss[i - 1] !== SS_STRAND) && (i === m - 1 || ss[i + 1] !== SS_STRAND)) ss[i] = 0;
    }

    // side vectors from the peptide plane (Carson & Bugg): perpendicular to the chain, in the C=O plane
    const side: Vec3[] = [];
    let previous: Vec3 | null = null;
    for (let i = 0; i < m; i++) {
      const along = i < m - 1 ? sub(raw[i + 1], raw[i]) : sub(raw[i], raw[i - 1]);
      let d: Vec3 | null = null;
      const o = seg[i].oxygen;
      if (chain.kind === 'protein' && o >= 0) {
        const c = cross(along, sub(atomPos(s, o), raw[i]));
        const candidate = normalize(cross(c, along));
        if (dot(candidate, candidate) > 0.5) d = candidate;
      }
      if (!d) {
        if (previous) {
          const t = normalize(along);
          const carried = normalize(sub(previous, [t[0] * dot(previous, t), t[1] * dot(previous, t), t[2] * dot(previous, t)]));
          d = dot(carried, carried) > 0.5 ? carried : perpendicular(t);
        } else d = perpendicular(normalize(along));
      }
      if (previous && dot(d, previous) < 0) d = [-d[0], -d[1], -d[2]];
      side.push(d);
      previous = d;
    }

    // flatten the zig-zag of strands so sheets come out as smooth arrows
    const pos: Vec3[] = raw.map((p, i) => {
      if (ss[i] !== SS_STRAND || i === 0 || i === m - 1) return p;
      const a = raw[i - 1];
      const b = raw[i + 1];
      return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4, (a[2] + 2 * p[2] + b[2]) / 4];
    });
    const smoothSide: Vec3[] = side.map((d, i) => {
      if (ss[i] !== SS_STRAND || i === 0 || i === m - 1) return d;
      return normalize([side[i - 1][0] + 2 * d[0] + side[i + 1][0], side[i - 1][1] + 2 * d[1] + side[i + 1][1], side[i - 1][2] + 2 * d[2] + side[i + 1][2]]);
    });

    const trace: TraceResidue[] = seg.map((r, i) => {
      const strandEnd = ss[i] === SS_STRAND && (i === m - 1 || ss[i + 1] !== SS_STRAND);
      let profile: Profile;
      if (tube) profile = TUBE;
      else if (chain.kind === 'nucleic') profile = NUCLEIC;
      else if (strandEnd) profile = COIL; // the arrow tapers to coil width at the strand's last residue
      else profile = ss[i] === SS_HELIX ? HELIX : ss[i] === SS_STRAND ? SHEET : COIL;
      return { position: pos[i], side: smoothSide[i], profile, color: colorOf(r), arrowTip: strandEnd && i > 0 && ss[i - 1] === SS_STRAND };
    });
    extrudeRibbon(mesh, trace, detail);

    // nucleic acids: a rung from the backbone to the base's Watson–Crick edge
    if (chain.kind === 'nucleic' && !tube) {
      for (let i = 0; i < m; i++) {
        const r = seg[i];
        const tip = findAtom(s, r, isPurine(r.name) ? 'N1' : 'N3');
        if (tip < 0) continue;
        const a = raw[i];
        const b = atomPos(s, tip);
        const color = colorOf(r);
        cylinders.push([a[0], a[1], a[2], b[0], b[1], b[2], 0.3], color);
        spheres.push([b[0], b[1], b[2], 0.3], color);
      }
    }
  }
}

export function buildScene(layers: Layer[]): SceneData {
  const mesh = new MeshBuilder();
  const spheres = new InstanceBuilder(4);
  const cylinders = new InstanceBuilder(7);
  const pickXyz: number[] = [];
  const pickRadius: number[] = [];
  const pickAtom: number[] = [];
  const pickLayer: number[] = [];

  layers.forEach((layer, layerIndex) => {
    const s = layer.structure;
    const colorOf = residueColorizer(layer);
    const plainColors = layer.color === 'uniform' || layer.color === 'deviation';
    const ribbon = layer.style === 'cartoon' || layer.style === 'tube';
    const spacefill = layer.style === 'spheres';

    const polymerAuthVisible = new Set<string>();
    if (layer.onlyChains) for (const c of s.chains) if (c.kind !== 'other' && layer.onlyChains.has(c.index)) polymerAuthVisible.add(c.id);

    let polymerResidues = 0;
    for (const c of s.chains) if (c.kind !== 'other') polymerResidues += c.sequenceResidues.length;
    const detail = ribbonDetail(polymerResidues);

    const pick = (atom: number, radius: number) => {
      pickXyz.push(s.xyz[atom * 3], s.xyz[atom * 3 + 1], s.xyz[atom * 3 + 2]);
      pickRadius.push(radius);
      pickAtom.push(atom);
      pickLayer.push(layerIndex);
    };

    const stickAtoms: number[] = [];
    const atomColor = (atom: number, r: Residue): RGB => {
      const polymer = r.kind === 'protein' || r.kind === 'nucleic';
      if (plainColors) return polymer ? colorOf(r) : s.element[atom] === EL_C ? layer.baseColor ?? LIGAND_CARBON : ELEMENTS[s.element[atom]].color;
      if (s.element[atom] !== EL_C) return ELEMENTS[s.element[atom]].color;
      return polymer ? colorOf(r) : LIGAND_CARBON;
    };

    for (const chain of s.chains) {
      if (!chainVisible(layer, chain, polymerAuthVisible)) continue;
      if (chain.kind !== 'other' && ribbon) {
        addRibbon(mesh, cylinders, spheres, layer, chain, colorOf, detail);
        for (const ri of chain.sequenceResidues) pick(s.residues[ri].trace, 1.7);
      }
      for (let ri = chain.residueStart; ri < chain.residueEnd; ri++) {
        const r = s.residues[ri];
        const polymer = r.kind === chain.kind; // true only for protein/nucleic residues of a polymer chain
        if (polymer && ribbon) continue;
        if (r.kind === 'water') {
          if (!layer.showWater) continue;
          for (let a = r.atomStart; a < r.atomEnd; a++) {
            spheres.push([s.xyz[a * 3], s.xyz[a * 3 + 1], s.xyz[a * 3 + 2], spacefill ? 1.4 : 0.32], ELEMENTS[s.element[a]].color);
            pick(a, spacefill ? 1.4 : 0.5);
          }
          continue;
        }
        if (!polymer && !layer.showLigands) continue;
        if (r.kind === 'ion') {
          const a = r.atomStart;
          const e = ELEMENTS[s.element[a]];
          const radius = spacefill ? e.vdw : Math.max(0.75, e.covalent * 0.7);
          spheres.push([s.xyz[a * 3], s.xyz[a * 3 + 1], s.xyz[a * 3 + 2], radius], e.color);
          pick(a, radius + 0.2);
          continue;
        }
        if (spacefill) {
          for (let a = r.atomStart; a < r.atomEnd; a++) {
            const radius = ELEMENTS[s.element[a]].vdw;
            spheres.push([s.xyz[a * 3], s.xyz[a * 3 + 1], s.xyz[a * 3 + 2], radius], atomColor(a, r));
            pick(a, radius);
          }
        } else {
          const ball = polymer ? 0.3 : 0.38;
          for (let a = r.atomStart; a < r.atomEnd; a++) {
            spheres.push([s.xyz[a * 3], s.xyz[a * 3 + 1], s.xyz[a * 3 + 2], ball], atomColor(a, r));
            pick(a, ball + 0.25);
            stickAtoms.push(a);
          }
        }
      }
    }

    if (stickAtoms.length > 1) {
      const bonds = findBonds(s, Int32Array.from(stickAtoms));
      for (let k = 0; k < bonds.length; k += 2) {
        const a = bonds[k];
        const b = bonds[k + 1];
        const ra = s.residues[s.atomResidue[a]];
        const rb = s.residues[s.atomResidue[b]];
        const polymerBond = (ra.kind === 'protein' || ra.kind === 'nucleic') && (rb.kind === 'protein' || rb.kind === 'nucleic');
        const radius = polymerBond ? 0.15 : 0.19;
        const ax = s.xyz[a * 3], ay = s.xyz[a * 3 + 1], az = s.xyz[a * 3 + 2];
        const bx = s.xyz[b * 3], by = s.xyz[b * 3 + 1], bz = s.xyz[b * 3 + 2];
        const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
        // two half-bonds, each in the colour of its atom
        cylinders.push([ax, ay, az, mx, my, mz, radius], atomColor(a, ra));
        cylinders.push([mx, my, mz, bx, by, bz, radius], atomColor(b, rb));
      }
    }
  });

  const count = pickAtom.length;
  const xyz = Float32Array.from(pickXyz);
  // bounding sphere of everything that can be picked (that is, everything drawn)
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < count; i++) {
    cx += xyz[i * 3];
    cy += xyz[i * 3 + 1];
    cz += xyz[i * 3 + 2];
  }
  if (count > 0) {
    cx /= count;
    cy /= count;
    cz /= count;
  }
  let r2 = 0;
  for (let i = 0; i < count; i++) {
    const dx = xyz[i * 3] - cx, dy = xyz[i * 3 + 1] - cy, dz = xyz[i * 3 + 2] - cz;
    r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
  }

  return {
    mesh: mesh.build(),
    spheres: spheres.build(),
    cylinders: cylinders.build(),
    pick: { xyz, radius: Float32Array.from(pickRadius), atom: Int32Array.from(pickAtom), layer: Uint8Array.from(pickLayer), count },
    center: [cx, cy, cz],
    radius: Math.sqrt(r2) + 3,
    empty: count === 0,
  };
}

/** Marker sphere (x, y, z, radius) that wraps one residue, for highlighting. */
export function residueMarker(s: Structure, residueIndex: number): [number, number, number, number] {
  const r = s.residues[residueIndex];
  if (r.trace >= 0) return [s.xyz[r.trace * 3], s.xyz[r.trace * 3 + 1], s.xyz[r.trace * 3 + 2], 2.3];
  let x = 0, y = 0, z = 0;
  const n = r.atomEnd - r.atomStart;
  for (let a = r.atomStart; a < r.atomEnd; a++) {
    x += s.xyz[a * 3];
    y += s.xyz[a * 3 + 1];
    z += s.xyz[a * 3 + 2];
  }
  x /= n; y /= n; z /= n;
  let far = 0;
  for (let a = r.atomStart; a < r.atomEnd; a++) far = Math.max(far, Math.hypot(s.xyz[a * 3] - x, s.xyz[a * 3 + 1] - y, s.xyz[a * 3 + 2] - z));
  return [x, y, z, far + 1.6];
}

/** Human-readable label for a picked atom. */
export function describeAtom(s: Structure, atom: number): { residue: Residue; chain: Chain; atomName: string } {
  const residue = s.residues[s.atomResidue[atom]];
  return { residue, chain: s.chains[residue.chain], atomName: s.atomName[atom] };
}
