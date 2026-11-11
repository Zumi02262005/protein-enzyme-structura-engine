import { memo } from 'react';
import { substitutionScore, type Alignment } from '../core/align';
import type { Chain, Structure } from '../core/types';

interface Props {
  alignment: Alignment;
  structureA: Structure;
  chainA: Chain;
  structureB: Structure;
  chainB: Chain;
  labelA: string;
  labelB: string;
  hoverColumn: number;
  onHover: (column: number) => void;
}

const BLOCK = 60;

/** The sequence alignment in blocks of 60 columns, with a match line between the two rows. */
export const AlignmentView = memo(function AlignmentView({ alignment, structureA, chainA, structureB, chainB, labelA, labelB, hoverColumn, onHover }: Props) {
  const total = alignment.alignedA.length;
  const protein = chainA.kind === 'protein';
  const blocks: number[] = [];
  for (let start = 0; start < total; start += BLOCK) blocks.push(start);

  /** Author number of the first residue at or after a column, for the block's margin. */
  const numberAt = (columns: Int32Array, chain: Chain, structure: Structure, start: number): string => {
    for (let c = start; c < Math.min(total, start + BLOCK); c++) {
      if (columns[c] >= 0) return String(structure.residues[chain.sequenceResidues[columns[c]]].seq);
    }
    return '';
  };

  return (
    <div
      className="alignment"
      onPointerOver={(e) => {
        const el = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[data-col]') : null;
        onHover(el ? Number(el.dataset.col) : -1);
      }}
      onPointerLeave={() => onHover(-1)}
    >
      {blocks.map((start) => (
        <div key={start} className="alignment-block">
          <div className="alignment-labels">
            <span>
              {labelA} <b>{numberAt(alignment.columnA, chainA, structureA, start)}</b>
            </span>
            <span />
            <span>
              {labelB} <b>{numberAt(alignment.columnB, chainB, structureB, start)}</b>
            </span>
          </div>
          <div className="alignment-columns">
            {Array.from({ length: Math.min(BLOCK, total - start) }, (_, k) => {
              const col = start + k;
              const a = alignment.alignedA[col];
              const b = alignment.alignedB[col];
              const gap = a === '-' || b === '-';
              const same = !gap && a === b;
              const similar = !gap && !same && protein && substitutionScore(a, b) > 0;
              let cls = 'alignment-col';
              if (same) cls += ' is-same';
              else if (gap) cls += ' is-gap';
              if (col === hoverColumn) cls += ' is-hover';
              return (
                <span key={col} data-col={col} className={cls}>
                  <span>{a}</span>
                  <span className="alignment-mark">{same ? '|' : similar ? ':' : ''}</span>
                  <span>{b}</span>
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
});
