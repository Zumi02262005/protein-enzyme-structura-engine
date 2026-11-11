/**
 * Fallback helix/strand assignment from Cα geometry alone, used only when a file carries no
 * secondary-structure records. It follows the distance and torsion windows of the P-SEA method
 * (Labesse et al., 1997), which is approximate by design.
 */
import type { SS, Structure } from './types';
import { SS_HELIX, SS_STRAND } from './types';

function dist(xyz: Float32Array, a: number, b: number): number {
  const dx = xyz[a * 3] - xyz[b * 3];
  const dy = xyz[a * 3 + 1] - xyz[b * 3 + 1];
  const dz = xyz[a * 3 + 2] - xyz[b * 3 + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Signed torsion angle a-b-c-d in degrees. */
function torsion(xyz: Float32Array, a: number, b: number, c: number, d: number): number {
  const p = (i: number, k: number) => xyz[i * 3 + k];
  const b1 = [p(b, 0) - p(a, 0), p(b, 1) - p(a, 1), p(b, 2) - p(a, 2)];
  const b2 = [p(c, 0) - p(b, 0), p(c, 1) - p(b, 1), p(c, 2) - p(b, 2)];
  const b3 = [p(d, 0) - p(c, 0), p(d, 1) - p(c, 1), p(d, 2) - p(c, 2)];
  const cross = (u: number[], v: number[]) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const n1 = cross(b1, b2);
  const n2 = cross(b2, b3);
  const len2 = Math.sqrt(dot(b2, b2));
  return (Math.atan2(len2 * dot(b1, n2), dot(n1, n2)) * 180) / Math.PI;
}

/** Returns true when at least one helix or strand was assigned. */
export function estimateSecondaryStructure(s: Structure): boolean {
  let any = false;
  for (const chain of s.chains) {
    if (chain.kind !== 'protein') continue;
    const res = chain.sequenceResidues;
    const n = res.length;
    if (n < 5) continue;
    const ca = res.map((r) => s.residues[r].trace);
    const ss = new Uint8Array(n);

    // windows of four consecutive residues that look helical / extended
    const helixWin = new Uint8Array(n);
    const strandWin = new Uint8Array(n);
    for (let i = 0; i + 3 < n; i++) {
      // skip windows that span a chain break
      if (dist(s.xyz, ca[i], ca[i + 1]) > 4.3 || dist(s.xyz, ca[i + 1], ca[i + 2]) > 4.3 || dist(s.xyz, ca[i + 2], ca[i + 3]) > 4.3) continue;
      const d2 = dist(s.xyz, ca[i], ca[i + 2]);
      const d3 = dist(s.xyz, ca[i], ca[i + 3]);
      const tau = torsion(s.xyz, ca[i], ca[i + 1], ca[i + 2], ca[i + 3]);
      if (Math.abs(d2 - 5.45) < 0.55 && Math.abs(d3 - 5.2) < 0.75 && tau > 25 && tau < 85) helixWin[i] = 1;
      else if (Math.abs(d2 - 6.6) < 0.7 && Math.abs(d3 - 9.9) < 1.1 && Math.abs(tau) > 120) strandWin[i] = 1;
    }
    const mark = (win: Uint8Array, code: SS, minWindows: number, reach: number) => {
      let i = 0;
      while (i < n) {
        if (!win[i]) {
          i++;
          continue;
        }
        let j = i;
        while (j < n && win[j]) j++;
        if (j - i >= minWindows) {
          for (let k = i; k < Math.min(n, j + reach); k++) if (ss[k] === 0 || code === SS_HELIX) ss[k] = code;
        }
        i = j;
      }
    };
    mark(strandWin, SS_STRAND, 2, 2);
    mark(helixWin, SS_HELIX, 3, 3);
    for (let i = 0; i < n; i++) {
      if (ss[i]) {
        s.residues[res[i]].ss = ss[i] as SS;
        any = true;
      }
    }
  }
  return any;
}
