/**
 * Geometry builders: growable vertex buffers, the cartoon/tube ribbon extruder, unit sphere and
 * cylinder templates for instancing, and distance-based bond detection.
 */
import { ELEMENTS } from '../core/chem';
import type { Structure, Vec3 } from '../core/types';
import { add, cross, dot, lerp, normalize, perpendicular, scale, sub } from './math';
import type { RGB } from './palette';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Uint8Array;
  indices: Uint32Array;
  vertexCount: number;
  indexCount: number;
}

export class MeshBuilder {
  private pos = new Float32Array(3 * 4096);
  private nrm = new Float32Array(3 * 4096);
  private col = new Uint8Array(4 * 4096);
  private idx = new Uint32Array(3 * 8192);
  vertexCount = 0;
  indexCount = 0;

  vertex(p: Vec3, n: Vec3, c: RGB): number {
    const v = this.vertexCount;
    if (v * 3 + 3 > this.pos.length) {
      const grow = <T extends Float32Array | Uint8Array>(a: T): T => {
        const b = new (a.constructor as { new (n: number): T })(a.length * 2);
        b.set(a);
        return b;
      };
      this.pos = grow(this.pos);
      this.nrm = grow(this.nrm);
      this.col = grow(this.col);
    }
    this.pos[v * 3] = p[0];
    this.pos[v * 3 + 1] = p[1];
    this.pos[v * 3 + 2] = p[2];
    this.nrm[v * 3] = n[0];
    this.nrm[v * 3 + 1] = n[1];
    this.nrm[v * 3 + 2] = n[2];
    this.col[v * 4] = c[0];
    this.col[v * 4 + 1] = c[1];
    this.col[v * 4 + 2] = c[2];
    this.col[v * 4 + 3] = 255;
    this.vertexCount++;
    return v;
  }

  triangle(a: number, b: number, c: number): void {
    if (this.indexCount + 3 > this.idx.length) {
      const bigger = new Uint32Array(this.idx.length * 2);
      bigger.set(this.idx);
      this.idx = bigger;
    }
    this.idx[this.indexCount++] = a;
    this.idx[this.indexCount++] = b;
    this.idx[this.indexCount++] = c;
  }

  build(): MeshData | null {
    if (this.indexCount === 0) return null;
    return {
      positions: this.pos.slice(0, this.vertexCount * 3),
      normals: this.nrm.slice(0, this.vertexCount * 3),
      colors: this.col.slice(0, this.vertexCount * 4),
      indices: this.idx.slice(0, this.indexCount),
      vertexCount: this.vertexCount,
      indexCount: this.indexCount,
    };
  }
}

/** Growable list of instances (a few floats plus an RGBA colour each). */
export class InstanceBuilder {
  private data: Float32Array;
  private col = new Uint8Array(4 * 1024);
  count = 0;
  constructor(private readonly stride: number) {
    this.data = new Float32Array(stride * 1024);
  }
  push(values: number[], c: RGB): void {
    if ((this.count + 1) * this.stride > this.data.length) {
      const d = new Float32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
      const k = new Uint8Array(this.col.length * 2);
      k.set(this.col);
      this.col = k;
    }
    this.data.set(values, this.count * this.stride);
    const o = this.count * 4;
    this.col[o] = c[0];
    this.col[o + 1] = c[1];
    this.col[o + 2] = c[2];
    this.col[o + 3] = 255;
    this.count++;
  }
  build(): InstanceData {
    return { data: this.data.slice(0, this.count * this.stride), colors: this.col.slice(0, this.count * 4), count: this.count };
  }
}

export interface InstanceData {
  data: Float32Array;
  colors: Uint8Array;
  count: number;
}

/* ------------------------------------------------------------------------------------------- */
/* Ribbon extrusion                                                                            */
/* ------------------------------------------------------------------------------------------- */

/** Cross-section of the ribbon at one residue. */
export interface Profile {
  /** Half-width along the ribbon's side direction, Å. */
  w: number;
  /** Half-thickness, Å. */
  h: number;
  /** Superellipse exponent: 2 = ellipse, larger = boxier. */
  e: number;
}

export interface TraceResidue {
  position: Vec3;
  /** Unit vector across the ribbon (in the peptide plane). */
  side: Vec3;
  profile: Profile;
  color: RGB;
  /** True when the stretch from the previous residue to this one is a strand's arrowhead. */
  arrowTip: boolean;
}

export interface RibbonDetail {
  /** Spline samples between two residues. */
  subdivisions: number;
  /** Vertices around the cross-section. */
  sides: number;
}

const ARROW_WIDTH = 1.55;

/** Extrude one continuous stretch of backbone into the mesh. */
export function extrudeRibbon(mesh: MeshBuilder, residues: TraceResidue[], detail: RibbonDetail): void {
  const m = residues.length;
  if (m < 2) return;
  const { subdivisions: S, sides: K } = detail;
  const P = residues.map((r) => r.position);

  const cos = new Float32Array(K);
  const sin = new Float32Array(K);
  for (let k = 0; k < K; k++) {
    cos[k] = Math.cos((2 * Math.PI * k) / K);
    sin[k] = Math.sin((2 * Math.PI * k) / K);
  }

  let prevSide: Vec3 | null = null;
  let prevTangent: Vec3 | null = null;
  let prevRing = -1;

  /** Add one ring of vertices; returns the index of its first vertex. */
  const ring = (center: Vec3, side: Vec3, up: Vec3, p: Profile, color: RGB, flat: Vec3 | null): number => {
    const first = mesh.vertexCount;
    const pe = 2 / p.e;
    const ne = 2 - pe;
    for (let k = 0; k < K; k++) {
      const c = cos[k];
      const s = sin[k];
      const ac = Math.abs(c);
      const as = Math.abs(s);
      const x = p.w * Math.sign(c) * Math.pow(ac, pe);
      const y = p.h * Math.sign(s) * Math.pow(as, pe);
      const pos: Vec3 = [center[0] + side[0] * x + up[0] * y, center[1] + side[1] * x + up[1] * y, center[2] + side[2] * x + up[2] * y];
      let n: Vec3;
      if (flat) n = flat;
      else {
        const nx = (Math.sign(c) * Math.pow(ac, ne)) / p.w;
        const ny = (Math.sign(s) * Math.pow(as, ne)) / p.h;
        n = normalize([side[0] * nx + up[0] * ny, side[1] * nx + up[1] * ny, side[2] * nx + up[2] * ny]);
      }
      mesh.vertex(pos, n, color);
    }
    return first;
  };
  const stitch = (a: number, b: number) => {
    for (let k = 0; k < K; k++) {
      const k1 = (k + 1) % K;
      mesh.triangle(a + k, b + k, a + k1);
      mesh.triangle(a + k1, b + k, b + k1);
    }
  };
  const cap = (center: Vec3, side: Vec3, up: Vec3, p: Profile, color: RGB, normal: Vec3) => {
    const rim = ring(center, side, up, p, color, normal);
    const hub = mesh.vertex(center, normal, color);
    for (let k = 0; k < K; k++) mesh.triangle(hub, rim + k, rim + ((k + 1) % K));
  };

  const mixProfile = (a: Profile, b: Profile, t: number): Profile => ({ w: a.w + (b.w - a.w) * t, h: a.h + (b.h - a.h) * t, e: a.e + (b.e - a.e) * t });

  for (let i = 0; i < m - 1; i++) {
    const p1 = P[i];
    const p2 = P[i + 1];
    const p0 = i > 0 ? P[i - 1] : sub(scale(p1, 2), p2);
    const p3 = i + 2 < m ? P[i + 2] : sub(scale(p2, 2), p1);
    const a = residues[i];
    const b = residues[i + 1];
    const arrow = b.arrowTip;
    const last = i === m - 2;
    const steps = last ? S + 1 : S;

    for (let s = 0; s < steps; s++) {
      const t = s / S;
      const t2 = t * t;
      const t3 = t2 * t;
      // Catmull–Rom spline through the trace atoms
      const pos: Vec3 = [0, 0, 0];
      const tan: Vec3 = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const c1 = -p0[c] + p2[c];
        const c2 = 2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c];
        const c3 = -p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c];
        pos[c] = 0.5 * (2 * p1[c] + c1 * t + c2 * t2 + c3 * t3);
        tan[c] = 0.5 * (c1 + 2 * c2 * t + 3 * c3 * t2);
      }
      let T = normalize(tan);
      if (dot(T, T) < 0.5) {
        // two trace atoms on the same spot: keep the previous direction
        T = prevTangent ?? normalize(sub(p3, p0));
        if (dot(T, T) < 0.5) T = [0, 0, 1];
      }
      prevTangent = T;
      // side vector: blend the residues' vectors, then make it perpendicular to the path
      let side = lerp(a.side, b.side, t);
      side = sub(side, scale(T, dot(side, T)));
      if (dot(side, side) < 1e-6) side = prevSide ? sub(prevSide, scale(T, dot(prevSide, T))) : perpendicular(T);
      side = normalize(side);
      if (dot(side, side) < 0.5) side = perpendicular(T);
      prevSide = side;
      const up = cross(T, side);

      const color = t < 0.5 ? a.color : b.color;
      const smooth = t * t * (3 - 2 * t);
      let profile: Profile;
      if (arrow) {
        profile = { w: ARROW_WIDTH + (b.profile.w - ARROW_WIDTH) * t, h: a.profile.h + (b.profile.h - a.profile.h) * t, e: a.profile.e };
      } else profile = mixProfile(a.profile, b.profile, smooth);

      if (i === 0 && s === 0) cap(pos, side, up, profile, color, scale(T, -1));

      if (arrow && s === 0) {
        // flare out to the arrowhead: a flat shoulder facing back along the chain
        const back = scale(T, -1);
        const body = ring(pos, side, up, a.profile, color, null);
        if (prevRing >= 0) stitch(prevRing, body);
        const inner = ring(pos, side, up, a.profile, color, back);
        const outer = ring(pos, side, up, profile, color, back);
        stitch(inner, outer);
        prevRing = ring(pos, side, up, profile, color, null);
      } else {
        const r = ring(pos, side, up, profile, color, null);
        if (prevRing >= 0) stitch(prevRing, r);
        prevRing = r;
      }

      if (last && s === S) cap(pos, side, up, profile, color, T);
    }
  }
}

/* ------------------------------------------------------------------------------------------- */
/* Instancing templates                                                                        */
/* ------------------------------------------------------------------------------------------- */

export interface Template {
  positions: Float32Array;
  indices: Uint16Array;
}

/** Unit icosphere. Vertex positions double as normals. */
export function icosphere(subdivisions: number): Template {
  const t = (1 + Math.sqrt(5)) / 2;
  let verts: Vec3[] = (
    [
      [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
      [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
    ] as Vec3[]
  ).map(normalize);
  let faces: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < subdivisions; s++) {
    const cache = new Map<number, number>();
    const next = verts.slice();
    const mid = (a: number, b: number): number => {
      const key = a < b ? a * 65536 + b : b * 65536 + a;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      next.push(normalize(add(next[a], next[b])));
      cache.set(key, next.length - 1);
      return next.length - 1;
    };
    const out: number[][] = [];
    for (const [a, b, c] of faces) {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      out.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    verts = next;
    faces = out;
  }
  return { positions: Float32Array.from(verts.flat()), indices: Uint16Array.from(faces.flat()) };
}

/** Open unit cylinder along +z from z = 0 to z = 1, radius 1. x, y double as the normal. */
export function cylinder(segments: number): Template {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let k = 0; k < segments; k++) {
    const a = (2 * Math.PI * k) / segments;
    positions.push(Math.cos(a), Math.sin(a), 0, Math.cos(a), Math.sin(a), 1);
  }
  for (let k = 0; k < segments; k++) {
    const a = k * 2;
    const b = ((k + 1) % segments) * 2;
    indices.push(a, b, a + 1, b, b + 1, a + 1);
  }
  return { positions: Float32Array.from(positions), indices: Uint16Array.from(indices) };
}

/* ------------------------------------------------------------------------------------------- */
/* Bonds                                                                                       */
/* ------------------------------------------------------------------------------------------- */

/**
 * Covalent bonds among the given atoms, inferred from interatomic distances with a uniform grid.
 * Returns a flat list of atom-index pairs.
 */
export function findBonds(s: Structure, atoms: Int32Array): Int32Array {
  const n = atoms.length;
  if (n < 2) return new Int32Array(0);
  const xyz = s.xyz;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let k = 0; k < n; k++) {
    const a = atoms[k] * 3;
    if (xyz[a] < minX) minX = xyz[a];
    if (xyz[a] > maxX) maxX = xyz[a];
    if (xyz[a + 1] < minY) minY = xyz[a + 1];
    if (xyz[a + 1] > maxY) maxY = xyz[a + 1];
    if (xyz[a + 2] < minZ) minZ = xyz[a + 2];
    if (xyz[a + 2] > maxZ) maxZ = xyz[a + 2];
  }
  const CELL = 3.0;
  const nx = Math.max(1, Math.ceil((maxX - minX) / CELL) + 1);
  const ny = Math.max(1, Math.ceil((maxY - minY) / CELL) + 1);
  const nz = Math.max(1, Math.ceil((maxZ - minZ) / CELL) + 1);
  if (nx * ny * nz > 60_000_000) return new Int32Array(0);
  const cellOf = new Int32Array(n);
  const counts = new Int32Array(nx * ny * nz + 1);
  for (let k = 0; k < n; k++) {
    const a = atoms[k] * 3;
    const c = Math.floor((xyz[a] - minX) / CELL) + nx * (Math.floor((xyz[a + 1] - minY) / CELL) + ny * Math.floor((xyz[a + 2] - minZ) / CELL));
    cellOf[k] = c;
    counts[c + 1]++;
  }
  for (let c = 0; c < counts.length - 1; c++) counts[c + 1] += counts[c];
  const start = counts.slice();
  const sorted = new Int32Array(n);
  for (let k = 0; k < n; k++) sorted[counts[cellOf[k]]++] = k;

  const pairs: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = atoms[k];
    const ra = s.residues[s.atomResidue[a]];
    if (ra.kind === 'ion' || ra.kind === 'water') continue;
    const ca = ELEMENTS[s.element[a]].covalent;
    const ax = xyz[a * 3], ay = xyz[a * 3 + 1], az = xyz[a * 3 + 2];
    const cx = Math.floor((ax - minX) / CELL), cy = Math.floor((ay - minY) / CELL), cz = Math.floor((az - minZ) / CELL);
    for (let dz = -1; dz <= 1; dz++) {
      const z = cz + dz;
      if (z < 0 || z >= nz) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= ny) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          if (x < 0 || x >= nx) continue;
          const c = x + nx * (y + ny * z);
          for (let q = start[c]; q < start[c + 1]; q++) {
            const kb = sorted[q];
            if (kb <= k) continue;
            const b = atoms[kb];
            const rb = s.residues[s.atomResidue[b]];
            if (rb.kind === 'ion' || rb.kind === 'water') continue;
            const ddx = xyz[b * 3] - ax, ddy = xyz[b * 3 + 1] - ay, ddz = xyz[b * 3 + 2] - az;
            const d2 = ddx * ddx + ddy * ddy + ddz * ddz;
            const reach = ca + ELEMENTS[s.element[b]].covalent + 0.45;
            if (d2 < reach * reach && d2 > 0.16) pairs.push(a, b);
          }
        }
      }
    }
  }
  return Int32Array.from(pairs);
}
