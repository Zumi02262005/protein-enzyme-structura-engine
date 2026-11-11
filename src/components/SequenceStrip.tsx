import { memo, useEffect, useRef } from 'react';
import type { Chain, Structure } from '../core/types';
import { SS_HELIX, SS_STRAND } from '../core/types';

interface Props {
  structure: Structure;
  chain: Chain;
  /** Residue index currently highlighted (from the 3D view or this strip), or -1. */
  active: number;
  /** Residue index pinned by a click, or -1. */
  selected: number;
  onHover: (residue: number) => void;
  onSelect: (residue: number) => void;
}

/** The chain's sequence as a scrolling row of letters with a helix/strand track underneath. */
export const SequenceStrip = memo(function SequenceStrip({ structure, chain, active, selected, onHover, onSelect }: Props) {
  const scroller = useRef<HTMLDivElement | null>(null);

  // bring a residue picked in the 3D view into sight
  useEffect(() => {
    if (selected < 0) return;
    const el = scroller.current?.querySelector<HTMLElement>(`[data-r="${selected}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [selected, chain]);

  const residueFrom = (target: EventTarget | null): number => {
    const el = target instanceof HTMLElement ? target.closest<HTMLElement>('[data-r]') : null;
    return el ? Number(el.dataset.r) : -1;
  };

  const step = (delta: number) => {
    const list = chain.sequenceResidues;
    const at = list.indexOf(selected >= 0 ? selected : active);
    const next = list[Math.min(list.length - 1, Math.max(0, at < 0 ? 0 : at + delta))];
    if (next !== undefined) onSelect(next);
  };

  return (
    <div
      ref={scroller}
      className="strip"
      tabIndex={0}
      role="group"
      aria-label={`Sequence of chain ${chain.id}. Use the left and right arrow keys to step through residues.`}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          step(e.key === 'ArrowRight' ? 1 : -1);
        }
      }}
      onPointerOver={(e) => onHover(residueFrom(e.target))}
      onPointerLeave={() => onHover(-1)}
      onClick={(e) => {
        const r = residueFrom(e.target);
        if (r >= 0) onSelect(r);
      }}
    >
      <div className="strip-row">
        {chain.sequenceResidues.map((ri, i) => {
          const r = structure.residues[ri];
          const ss = chain.kind === 'nucleic' ? 'n' : r.ss === SS_HELIX ? 'h' : r.ss === SS_STRAND ? 'e' : 'c';
          let cls = `strip-cell ss-${ss}`;
          if (ri === selected) cls += ' is-selected';
          else if (ri === active) cls += ' is-active';
          const tick = r.seq % 10 === 0 || i === 0;
          return (
            <span key={ri} data-r={ri} className={cls} title={`${r.name} ${r.seq}${r.insCode}`}>
              <span className="strip-number">{tick ? r.seq : ''}</span>
              <span className="strip-letter">{r.code}</span>
              <span className="strip-ss" />
            </span>
          );
        })}
      </div>
    </div>
  );
});
