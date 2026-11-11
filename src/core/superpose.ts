/**
 * Least-squares rigid-body superposition (Horn's closed-form quaternion solution).
 * Finds the rotation R and translation t that best map the "mobile" points onto the "target".
 */

export interface RigidTransform {
  /** Row-major 3×3 rotation matrix. */
  rotation: number[];
  translation: [number, number, number];
}

export const IDENTITY_TRANSFORM: RigidTransform = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] };

/** Largest eigenvalue's eigenvector of a symmetric 4×4 matrix (cyclic Jacobi rotations). */
function principalEigenvector4(m: number[][]): number[] {
  const a = m.map((row) => row.slice());
  const v = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] * a[p][q];
    if (off < 1e-22) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 4; k++) {
          const akp = a[k][p];
          const akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 4; k++) {
          const apk = a[p][k];
          const aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k][p];
          const vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let k = 1; k < 4; k++) if (a[k][k] > a[best][best]) best = k;
  return [v[0][best], v[1][best], v[2][best], v[3][best]];
}

/**
 * Best-fit transform taking `mobile` onto `target`. Both arrays hold x, y, z triples and must be
 * the same length. `use` optionally restricts the fit to a subset of point indices.
 */
export function fitTransform(mobile: Float64Array, target: Float64Array, use?: number[]): RigidTransform {
  const total = mobile.length / 3;
  const idx = use ?? Array.from({ length: total }, (_, i) => i);
  const n = idx.length;
  if (n < 3) throw new Error('At least three matched residues are needed to superpose two structures.');

  let mx = 0, my = 0, mz = 0, tx = 0, ty = 0, tz = 0;
  for (const i of idx) {
    mx += mobile[i * 3];
    my += mobile[i * 3 + 1];
    mz += mobile[i * 3 + 2];
    tx += target[i * 3];
    ty += target[i * 3 + 1];
    tz += target[i * 3 + 2];
  }
  mx /= n; my /= n; mz /= n; tx /= n; ty /= n; tz /= n;

  let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0;
  for (const i of idx) {
    const px = mobile[i * 3] - mx, py = mobile[i * 3 + 1] - my, pz = mobile[i * 3 + 2] - mz;
    const qx = target[i * 3] - tx, qy = target[i * 3 + 1] - ty, qz = target[i * 3 + 2] - tz;
    Sxx += px * qx; Sxy += px * qy; Sxz += px * qz;
    Syx += py * qx; Syy += py * qy; Syz += py * qz;
    Szx += pz * qx; Szy += pz * qy; Szz += pz * qz;
  }
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  const q = principalEigenvector4(N);
  const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  const w = q[0] / len, x = q[1] / len, y = q[2] / len, z = q[3] / len;
  const rotation = [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
  const translation: [number, number, number] = [
    tx - (rotation[0] * mx + rotation[1] * my + rotation[2] * mz),
    ty - (rotation[3] * mx + rotation[4] * my + rotation[5] * mz),
    tz - (rotation[6] * mx + rotation[7] * my + rotation[8] * mz),
  ];
  return { rotation, translation };
}

/** Apply a transform to x, y, z triples, returning a new array of the same type. */
export function applyTransform<T extends Float32Array | Float64Array>(points: T, t: RigidTransform): T {
  const out = points.slice() as T;
  const r = t.rotation;
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i], y = points[i + 1], z = points[i + 2];
    out[i] = r[0] * x + r[1] * y + r[2] * z + t.translation[0];
    out[i + 1] = r[3] * x + r[4] * y + r[5] * z + t.translation[1];
    out[i + 2] = r[6] * x + r[7] * y + r[8] * z + t.translation[2];
  }
  return out;
}

/** Distance between each pair of corresponding points. */
export function pairDistances(a: Float64Array, b: Float64Array): Float64Array {
  const n = a.length / 3;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.hypot(a[i * 3] - b[i * 3], a[i * 3 + 1] - b[i * 3 + 1], a[i * 3 + 2] - b[i * 3 + 2]);
  }
  return out;
}

export function rmsd(distances: Float64Array, use?: number[]): number {
  let sum = 0;
  if (use) {
    for (const i of use) sum += distances[i] * distances[i];
    return use.length ? Math.sqrt(sum / use.length) : 0;
  }
  for (let i = 0; i < distances.length; i++) sum += distances[i] * distances[i];
  return distances.length ? Math.sqrt(sum / distances.length) : 0;
}

export interface Superposition {
  transform: RigidTransform;
  /** Distance of every matched pair after superposition, Å. */
  distances: Float64Array;
  /** Indices of the pairs kept in the final fit ("core"). */
  core: number[];
  rmsdCore: number;
  rmsdAll: number;
}

/**
 * Superpose with outlier rejection: fit, drop pairs further apart than twice the current RMSD
 * (never tighter than 1 Å), and refit, for up to `cycles` rounds. Flexible loops then stop
 * dragging the well-conserved core out of register.
 */
export function superpose(mobile: Float64Array, target: Float64Array, cycles = 5): Superposition {
  const n = mobile.length / 3;
  let core = Array.from({ length: n }, (_, i) => i);
  let transform = fitTransform(mobile, target, core);
  let distances = pairDistances(applyTransform(mobile, transform), target);
  for (let c = 0; c < cycles; c++) {
    const current = rmsd(distances, core);
    const cutoff = Math.max(1, 2 * current);
    const kept = core.filter((i) => distances[i] <= cutoff);
    if (kept.length === core.length || kept.length < Math.max(3, Math.ceil(n * 0.3))) break;
    core = kept;
    transform = fitTransform(mobile, target, core);
    distances = pairDistances(applyTransform(mobile, transform), target);
  }
  return { transform, distances, core, rmsdCore: rmsd(distances, core), rmsdAll: rmsd(distances) };
}
