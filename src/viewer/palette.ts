/** Colours used inside the 3D view. Everything is derived from the app's green palette. */

export type RGB = [number, number, number];

export function hex(value: string): RGB {
  return [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)];
}

export function toHex(c: RGB): string {
  return '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

/** Distinct but muted hues for telling chains apart. */
export const CHAIN_COLORS: RGB[] = [
  '#a8cc9c', // leaf
  '#8fb9c9', // lichen blue
  '#e6d79a', // straw
  '#d7a79b', // clay rose
  '#74a886', // fern
  '#dfe8eb', // mist
  '#b9a9d4', // heather
  '#e0b98a', // sand
  '#7fc4b4', // sea green
  '#a9b47a', // olive
  '#c9d7a0', // lime wash
  '#9aa6c9', // slate blue
].map(hex);

export const SS_COLORS: Record<'coil' | 'helix' | 'strand' | 'nucleic', RGB> = {
  helix: hex('#a8cc9c'),
  strand: hex('#e6d28a'),
  coil: hex('#8fa69f'),
  nucleic: hex('#8fb9c9'),
};

/** N-terminus → C-terminus. */
export const RAINBOW: RGB[] = ['#4f8794', '#69a89d', '#93c79b', '#cfdd9b', '#f0d58a', '#e9b07a'].map(hex);

/** Low → high temperature factor. */
export const BFACTOR: RGB[] = ['#48707a', '#6fa391', '#a8cc9c', '#eadf9c', '#eba678'].map(hex);

/** Small → large distance between matched residues. */
export const DEVIATION_FAR: RGB[] = ['#ead48a', '#e58b6b'].map(hex);

export const COMPARE_A: RGB = hex('#a8cc9c');
export const COMPARE_B: RGB = hex('#dfe8eb');
export const UNMATCHED: RGB = hex('#5d7068');
export const LIGAND_CARBON: RGB = hex('#e6eef0');
export const HIGHLIGHT: RGB = hex('#f4ffd9');

export function mix(a: RGB, b: RGB, t: number): RGB {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Sample a multi-stop gradient at t in [0, 1]. */
export function ramp(stops: RGB[], t: number): RGB {
  const x = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  return mix(stops[i], stops[i + 1], x - i);
}

/** Colour for a residue-to-residue distance: the base colour up close, warming as it grows. */
export function deviationColor(base: RGB, distance: number): RGB {
  if (distance <= 1) return base;
  if (distance <= 2.5) return mix(base, DEVIATION_FAR[0], (distance - 1) / 1.5);
  return mix(DEVIATION_FAR[0], DEVIATION_FAR[1], Math.min(1, (distance - 2.5) / 2.5));
}
