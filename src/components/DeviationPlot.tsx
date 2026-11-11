import { memo, useMemo, useRef } from 'react';
import { COMPARE_A, deviationColor, toHex } from '../viewer/palette';

interface Props {
  /** Distance per alignment column in Å; -1 marks a gap. */
  distances: Float32Array;
  hoverColumn: number;
  onHover: (column: number) => void;
}

/** Bar chart of how far apart each matched residue pair sits after superposition. */
export const DeviationPlot = memo(function DeviationPlot({ distances, hoverColumn, onHover }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const n = distances.length;
  const top = useMemo(() => {
    let max = 0;
    for (let i = 0; i < n; i++) max = Math.max(max, distances[i]);
    return Math.max(4, Math.ceil(max / 2) * 2);
  }, [distances, n]);

  const bars = useMemo(() => {
    const out: Array<{ x: number; h: number; fill: string }> = [];
    for (let i = 0; i < n; i++) {
      const d = distances[i];
      if (d < 0) continue;
      out.push({ x: i, h: Math.max(0.6, (Math.min(d, top) / top) * 100), fill: toHex(deviationColor(COMPARE_A, d)) });
    }
    return out;
  }, [distances, n, top]);

  const columnAt = (clientX: number): number => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return -1;
    return Math.min(n - 1, Math.max(0, Math.floor(((clientX - rect.left) / rect.width) * n)));
  };
  const ticks = [top, top / 2, 0];

  return (
    <div className="plot">
      <div className="plot-axis" aria-hidden="true">
        {ticks.map((t) => (
          <span key={t}>{t} Å</span>
        ))}
      </div>
      <div ref={ref} className="plot-area" onPointerMove={(e) => onHover(columnAt(e.clientX))} onPointerLeave={() => onHover(-1)}>
        <svg viewBox={`0 0 ${n} 100`} preserveAspectRatio="none" role="img" aria-label="Distance between matched residues along the alignment">
          <line x1="0" x2={n} y1="50" y2="50" className="plot-grid" />
          <line x1="0" x2={n} y1="0.5" y2="0.5" className="plot-grid" />
          {bars.map((b) => (
            <rect key={b.x} x={b.x + 0.08} y={100 - b.h} width={0.84} height={b.h} fill={b.fill} />
          ))}
          {hoverColumn >= 0 ? <rect x={hoverColumn} y={0} width={1} height={100} className="plot-cursor" /> : null}
        </svg>
      </div>
    </div>
  );
});
