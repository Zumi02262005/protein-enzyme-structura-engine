import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LARGE_STRUCTURE_ATOMS, fetchEntry, fetchStructure, formatCount, formatResolution, formatYear, looksLikePdbId, normalizeId, type EntryMeta } from '../api/rcsb';
import { AlignmentView } from '../components/AlignmentView';
import { DeviationPlot } from '../components/DeviationPlot';
import { Icon } from '../components/Icon';
import { Segmented } from '../components/Segmented';
import { ErrorNote, Spinner } from '../components/States';
import { StructureCanvas } from '../components/StructureCanvas';
import { bestChainPair, comparableChains, compareChains, transformStructure, type ChainComparison } from '../core/compare';
import type { Chain, Structure } from '../core/types';
import { useAsync, useElementHeight, useMediaQuery, type Async } from '../hooks';
import { compareHref, formatSlot, navigate, parseSlot, viewHref } from '../router';
import { COMPARE_A, COMPARE_B } from '../viewer/palette';
import type { PickHit } from '../viewer/renderer';
import { residueMarker, type Layer } from '../viewer/scene';

type CompareStyle = 'cartoon' | 'tube';
type CompareColor = 'uniform' | 'deviation';
type Scope = 'chains' | 'all';

const STYLES: ReadonlyArray<{ value: CompareStyle; label: string }> = [
  { value: 'cartoon', label: 'Cartoon' },
  { value: 'tube', label: 'Tube' },
];
const COLORS: ReadonlyArray<{ value: CompareColor; label: string }> = [
  { value: 'uniform', label: 'By structure' },
  { value: 'deviation', label: 'By distance' },
];
const SCOPES: ReadonlyArray<{ value: Scope; label: string }> = [
  { value: 'chains', label: 'Matched chains' },
  { value: 'all', label: 'Whole entries' },
];
const EXAMPLES: Array<{ a: string; b: string; label: string }> = [
  { a: '4HHB.A', b: '1MBN.A', label: 'Haemoglobin α and myoglobin' },
  { a: '2LYZ', b: '1LZ1', label: 'Hen and human lysozyme' },
  { a: '4HHB', b: '1HHO', label: 'Haemoglobin without and with oxygen' },
];

interface Side {
  id: string;
  meta: Async<EntryMeta>;
  structure: Async<Structure>;
  tooLarge: boolean;
}

function useSide(id: string): Side {
  const meta = useAsync(id ? `meta:${id}` : null, (signal) => fetchEntry(id, signal));
  const tooLarge = meta.status === 'ready' && (meta.data.atomCount ?? 0) > LARGE_STRUCTURE_ATOMS;
  const structure = useAsync(meta.status === 'ready' && !tooLarge ? `cif:${id}` : null, () => fetchStructure(id));
  return { id, meta, structure, tooLarge };
}

export function ComparePage({ a, b }: { a: string; b: string }) {
  const slotA = parseSlot(a);
  const slotB = parseSlot(b);
  const idA = slotA.id ? normalizeId(slotA.id) : '';
  const idB = slotB.id ? normalizeId(slotB.id) : '';
  const sideA = useSide(idA);
  const sideB = useSide(idB);
  const structureA = sideA.structure.status === 'ready' ? sideA.structure.data : null;
  const structureB = sideB.structure.status === 'ready' ? sideB.structure.data : null;

  const setSlots = (nextA: string, nextB: string, replace = false) => navigate(compareHref(nextA, nextB), replace);

  // which chains to compare: from the address when given, otherwise the best-matching pair
  const chosen = useMemo(() => {
    if (!structureA || !structureB) return null;
    const listA = comparableChains(structureA);
    const listB = comparableChains(structureB);
    if (listA.length === 0 || listB.length === 0) return { listA, listB, chainA: undefined as Chain | undefined, chainB: undefined as Chain | undefined };
    const fixedA = slotA.chain ? listA.find((c) => c.id === slotA.chain) : undefined;
    const fixedB = slotB.chain ? listB.find((c) => c.id === slotB.chain) : undefined;
    if (fixedA && fixedB) return { listA, listB, chainA: fixedA, chainB: fixedB };
    const pair = bestChainPair(structureA, structureB, fixedA?.index, fixedB?.index);
    const chainA = fixedA ?? (pair ? structureA.chains[pair[0]] : listA[0]);
    const chainB = fixedB ?? (pair ? structureB.chains[pair[1]] : listB[0]);
    return { listA, listB, chainA, chainB };
  }, [structureA, structureB, slotA.chain, slotB.chain]);

  const result = useMemo<{ comparison: ChainComparison; moved: Structure } | { error: string } | null>(() => {
    if (!structureA || !structureB || !chosen) return null;
    if (!chosen.chainA || !chosen.chainB) return { error: 'One of these entries has no protein or nucleic acid chain to compare.' };
    try {
      const comparison = compareChains(structureA, chosen.chainA.index, structureB, chosen.chainB.index);
      return { comparison, moved: transformStructure(structureB, comparison.transform) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'These two chains could not be compared.' };
    }
  }, [structureA, structureB, chosen]);

  const ready = structureA && structureB && chosen?.chainA && chosen.chainB && result && 'comparison' in result;

  return (
    <main className={ready ? 'compare' : 'compare compare-setup'}>
      {ready ? (
        <Comparison
          metaA={(sideA.meta as { data: EntryMeta }).data}
          metaB={(sideB.meta as { data: EntryMeta }).data}
          structureA={structureA}
          structureB={result.moved}
          chainA={chosen.chainA!}
          chainB={chosen.chainB!}
          listA={chosen.listA}
          listB={chosen.listB}
          comparison={result.comparison}
          onChains={(ca, cb) => setSlots(formatSlot(idA, ca), formatSlot(idB, cb), true)}
          onIds={(na, nb) => setSlots(na, nb)}
        />
      ) : (
        <section className="setup glass">
          <h1 className="setup-title">Compare two structures</h1>
          <p className="setup-lede">Enter two PDB IDs. Structura matches their chains by sequence, lays one over the other, and measures how far apart they sit.</p>
          <SlotForm idA={idA} idB={idB} onSubmit={(na, nb) => setSlots(na, nb)} />
          <div className="setup-status">
            <SideStatus side={sideA} letter="A" />
            <SideStatus side={sideB} letter="B" />
            {result && 'error' in result ? <ErrorNote title="These two cannot be compared" detail={result.error} /> : null}
          </div>
          <div className="examples">
            <span className="examples-label">Try</span>
            {EXAMPLES.map((ex) => (
              <a key={ex.label} className="chip" href={compareHref(ex.a, ex.b)}>
                {ex.label}
              </a>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function SideStatus({ side, letter }: { side: Side; letter: string }) {
  if (!side.id) return null;
  if (side.meta.status === 'error') return <ErrorNote title={`Structure ${letter} (${side.id}) could not be loaded`} detail={side.meta.error.message} />;
  if (side.tooLarge) return <ErrorNote title={`${side.id} is too large to compare here`} detail={`It has more than ${formatCount(LARGE_STRUCTURE_ATOMS)} atoms. Pick a smaller entry.`} />;
  if (side.structure.status === 'error') return <ErrorNote title={`The coordinates for ${side.id} could not be loaded`} detail={side.structure.error.message} />;
  if (side.structure.status === 'ready') return null;
  return <Spinner label={`Loading ${side.id}…`} />;
}

function SlotForm({ idA, idB, onSubmit, compact = false }: { idA: string; idB: string; onSubmit: (a: string, b: string) => void; compact?: boolean }) {
  const [a, setA] = useState(idA);
  const [b, setB] = useState(idB);
  const [problem, setProblem] = useState('');
  useEffect(() => setA(idA), [idA]);
  useEffect(() => setB(idB), [idB]);

  const submit = (e: { preventDefault(): void }) => {
    e.preventDefault();
    const ta = a.trim();
    const tb = b.trim();
    if (!looksLikePdbId(ta) || !looksLikePdbId(tb)) {
      setProblem('Enter two PDB IDs, such as 4HHB and 1MBN.');
      return;
    }
    setProblem('');
    onSubmit(normalizeId(ta), normalizeId(tb));
  };
  return (
    <form className={compact ? 'slots slots-compact' : 'slots'} onSubmit={submit}>
      <label className="slot">
        <span className="slot-label">
          <span className="dot dot-a" aria-hidden="true" />
          Structure A
        </span>
        <input value={a} onChange={(e) => setA(e.target.value)} placeholder="4HHB" spellCheck={false} autoComplete="off" maxLength={12} />
      </label>
      <button
        type="button"
        className="icon-button"
        onClick={() => {
          setA(b);
          setB(a);
          if (looksLikePdbId(a.trim()) && looksLikePdbId(b.trim())) onSubmit(normalizeId(b), normalizeId(a));
        }}
        aria-label="Swap the two structures"
        title="Swap"
      >
        <Icon name="swap" size={16} />
      </button>
      <label className="slot">
        <span className="slot-label">
          <span className="dot dot-b" aria-hidden="true" />
          Structure B
        </span>
        <input value={b} onChange={(e) => setB(e.target.value)} placeholder="1MBN" spellCheck={false} autoComplete="off" maxLength={12} />
      </label>
      <button type="submit" className="button button-primary">
        Compare
      </button>
      {problem ? (
        <p className="slots-problem" role="alert">
          {problem}
        </p>
      ) : null}
    </form>
  );
}

interface ComparisonProps {
  metaA: EntryMeta;
  metaB: EntryMeta;
  structureA: Structure;
  /** Already moved onto structure A. */
  structureB: Structure;
  chainA: Chain;
  chainB: Chain;
  listA: Chain[];
  listB: Chain[];
  comparison: ChainComparison;
  onChains: (chainA: string, chainB: string) => void;
  onIds: (a: string, b: string) => void;
}

function Comparison({ metaA, metaB, structureA, structureB, chainA, chainB, listA, listB, comparison, onChains, onIds }: ComparisonProps) {
  const wide = useMediaQuery('(min-width: 1080px)');
  const [style, setStyle] = useState<CompareStyle>('cartoon');
  const [color, setColor] = useState<CompareColor>('uniform');
  const [scope, setScope] = useState<Scope>('chains');
  const [hoverColumn, setHoverColumn] = useState(-1);
  const [tip, setTip] = useState<{ layer: number; residue: number } | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [analysisPanel, analysisHeight] = useElementHeight<HTMLElement>();

  const layers = useMemo<Layer[]>(() => {
    const only = scope === 'chains';
    return [
      { structure: structureA, style, color, baseColor: COMPARE_A, deviation: comparison.distanceA, onlyChains: only ? new Set([chainA.index]) : undefined, showLigands: !only, showWater: false },
      { structure: structureB, style, color, baseColor: COMPARE_B, deviation: comparison.distanceB, onlyChains: only ? new Set([chainB.index]) : undefined, showLigands: !only, showWater: false },
    ];
  }, [structureA, structureB, chainA, chainB, comparison, style, color, scope]);

  // residue ↔ alignment column lookups
  const columns = useMemo(() => {
    const { columnA, columnB } = comparison.alignment;
    const residueA = Array.from(columnA, (i) => (i >= 0 ? chainA.sequenceResidues[i] : -1));
    const residueB = Array.from(columnB, (i) => (i >= 0 ? chainB.sequenceResidues[i] : -1));
    const ofA = new Map<number, number>();
    const ofB = new Map<number, number>();
    residueA.forEach((r, col) => r >= 0 && ofA.set(r, col));
    residueB.forEach((r, col) => r >= 0 && ofB.set(r, col));
    return { residueA, residueB, ofA, ofB };
  }, [comparison, chainA, chainB]);

  const highlights = useMemo(() => {
    const marks: number[] = [];
    if (hoverColumn >= 0) {
      const ra = columns.residueA[hoverColumn];
      const rb = columns.residueB[hoverColumn];
      if (ra >= 0) marks.push(...residueMarker(structureA, ra));
      if (rb >= 0) marks.push(...residueMarker(structureB, rb));
    } else if (tip) {
      marks.push(...residueMarker(tip.layer === 0 ? structureA : structureB, tip.residue));
    }
    return Float32Array.from(marks);
  }, [hoverColumn, tip, columns, structureA, structureB]);

  const onHover = useCallback(
    (hit: PickHit | null, x: number, y: number) => {
      const el = tooltipRef.current;
      if (el && hit) {
        el.style.left = `${x + 16}px`;
        el.style.top = `${y + 18}px`;
      }
      if (!hit) {
        setTip(null);
        setHoverColumn(-1);
        return;
      }
      const s = hit.layer === 0 ? structureA : structureB;
      const residue = s.atomResidue[hit.atom];
      setTip({ layer: hit.layer, residue });
      setHoverColumn((hit.layer === 0 ? columns.ofA.get(residue) : columns.ofB.get(residue)) ?? -1);
    },
    [structureA, structureB, columns],
  );

  const hoverText = useMemo(() => {
    if (hoverColumn < 0) return '';
    const ra = columns.residueA[hoverColumn];
    const rb = columns.residueB[hoverColumn];
    const name = (s: Structure, r: number) => (r >= 0 ? `${s.residues[r].name} ${s.residues[r].seq}` : 'gap');
    const d = comparison.columnDistance[hoverColumn];
    return `${name(structureA, ra)} ↔ ${name(structureB, rb)}${d >= 0 ? `: ${d.toFixed(2)} Å apart` : ''}`;
  }, [hoverColumn, columns, comparison, structureA, structureB]);

  const identity = comparison.identity * 100;
  const protein = chainA.kind === 'protein';
  // reasons to read the numbers with care
  const cautions: string[] = [];
  if (comparison.coverage < 0.5) cautions.push(`Only ${Math.round(comparison.coverage * 100)}% of the shorter chain could be matched to the other one.`);
  if (protein && comparison.identity < 0.25) cautions.push(`The matched residues are only ${identity.toFixed(0)}% identical. Pairs are chosen by sequence, so some of them may be wrong.`);
  if (protein && comparison.tmScore < 0.3) cautions.push('The two chains do not overlay well, which usually means they fold differently.');
  const tipResidue = tip ? (tip.layer === 0 ? structureA : structureB).residues[tip.residue] : null;
  const labelA = `${metaA.id} ${chainA.id}`;
  const labelB = `${metaB.id} ${chainB.id}`;
  const unit = protein ? 'Cα' : 'backbone';

  return (
    <>
      <div className="viewer-stage">
        <StructureCanvas
          layers={layers}
          fitKey={`${metaA.id}.${chainA.index}|${metaB.id}.${chainB.index}|${scope}`}
          highlights={highlights}
          padding={wide ? { left: 404, right: 24, top: 84, bottom: analysisHeight + 40 } : undefined}
          label={`${labelA} and ${labelB} superposed in 3D`}
          onHover={onHover}
        />
      </div>

      <aside className="panel panel-info panel-compare glass" aria-label="Comparison">
        <div className="panel-scroll">
          <SlotForm idA={metaA.id} idB={metaB.id} onSubmit={onIds} compact />

          <div className="pair">
            <PairSide letter="a" meta={metaA} chain={chainA} chains={listA} onChain={(id) => onChains(id, chainB.id)} />
            <PairSide letter="b" meta={metaB} chain={chainB} chains={listB} onChain={(id) => onChains(chainA.id, id)} />
          </div>

          <div className="metrics">
            <div className="metric metric-main">
              <span className="metric-value">
                {comparison.rmsdCore.toFixed(2)}
                <small> Å</small>
              </span>
              <span className="metric-label">RMSD over the {formatCount(comparison.coreCount)} best-fitting {unit} pairs</span>
            </div>
            <div className="metric">
              <span className="metric-value">
                {comparison.rmsdAll.toFixed(2)}
                <small> Å</small>
              </span>
              <span className="metric-label">RMSD over all {formatCount(comparison.matched)} matched pairs</span>
            </div>
            <div className="metric">
              <span className="metric-value">
                {identity.toFixed(identity >= 99.95 ? 0 : 1)}
                <small> %</small>
              </span>
              <span className="metric-label">Sequence identity</span>
            </div>
            <div className="metric">
              <span className="metric-value">
                {Math.round(comparison.coverage * 100)}
                <small> %</small>
              </span>
              <span className="metric-label">Of the shorter chain is matched</span>
            </div>
            {protein ? (
              <div className="metric">
                <span className="metric-value">{comparison.tmScore.toFixed(2)}</span>
                <span className="metric-label">TM-score (above 0.5 usually means the same fold)</span>
              </div>
            ) : null}
          </div>

          {cautions.length > 0 ? <p className="panel-note panel-note-warn">{cautions.join(' ')} Read the numbers above with care.</p> : null}

          <h2 className="panel-heading">Show</h2>
          <Segmented label="What to draw" options={SCOPES} value={scope} onChange={setScope} />
          <div className="panel-row">
            <Segmented label="Drawing style" options={STYLES} value={style} onChange={setStyle} />
          </div>
          <div className="panel-row">
            <Segmented label="Colour scheme" options={COLORS} value={color} onChange={setColor} />
          </div>
          {color === 'deviation' ? (
            <div className="legend-ramp">
              <span>Close</span>
              <span className="ramp ramp-deviation" />
              <span>5 Å+</span>
            </div>
          ) : (
            <ul className="legend">
              <li>
                <span className="dot dot-a" />
                {labelA}
              </li>
              <li>
                <span className="dot dot-b" />
                {labelB}
              </li>
            </ul>
          )}

          <h2 className="panel-heading">Side by side</h2>
          <table className="versus">
            <thead>
              <tr>
                <td />
                <th scope="col">{metaA.id}</th>
                <th scope="col">{metaB.id}</th>
              </tr>
            </thead>
            <tbody>
              <VersusRow label="Method" a={metaA.methodShort} b={metaB.methodShort} />
              <VersusRow label="Resolution" a={formatResolution(metaA.resolution) || 'n/a'} b={formatResolution(metaB.resolution) || 'n/a'} />
              <VersusRow label="Released" a={formatYear(metaA.released)} b={formatYear(metaB.released)} />
              <VersusRow label="Chain length" a={formatCount(chainA.sequence.length)} b={formatCount(chainB.sequence.length)} />
              <VersusRow label="Source" a={metaA.organisms[0] ?? ''} b={metaB.organisms[0] ?? ''} italic />
            </tbody>
          </table>
          <p className="panel-note">Structure B is moved onto structure A. The fit drops pairs more than twice the RMSD apart, so flexible loops do not skew it.</p>
        </div>
      </aside>

      <section ref={analysisPanel} className="panel panel-analysis glass" aria-label="Residue by residue">
        <div className="analysis-head">
          <h2 className="panel-heading">Distance along the alignment</h2>
          <span className="sequence-readout" aria-live="polite">
            {hoverText}
          </span>
        </div>
        <DeviationPlot distances={comparison.columnDistance} hoverColumn={hoverColumn} onHover={setHoverColumn} />
        <AlignmentView alignment={comparison.alignment} structureA={structureA} chainA={chainA} structureB={structureB} chainB={chainB} labelA={labelA} labelB={labelB} hoverColumn={hoverColumn} onHover={setHoverColumn} />
      </section>

      <div ref={tooltipRef} className={tipResidue ? 'tooltip is-visible' : 'tooltip'} role="presentation">
        {tipResidue && tip ? (
          <>
            <strong>
              {tipResidue.name} {tipResidue.seq}
              {tipResidue.insCode}
            </strong>
            <span>{tip.layer === 0 ? labelA : labelB}</span>
          </>
        ) : null}
      </div>
    </>
  );
}

function PairSide({ letter, meta, chain, chains, onChain }: { letter: 'a' | 'b'; meta: EntryMeta; chain: Chain; chains: Chain[]; onChain: (id: string) => void }) {
  return (
    <div className="pair-side">
      <p className="pair-id">
        <span className={`dot dot-${letter}`} aria-hidden="true" />
        <a href={viewHref(meta.id)} title={`Open ${meta.id} on its own`}>
          {meta.id}
        </a>
      </p>
      <p className="pair-title">{meta.title}</p>
      <label className="select">
        <span className="visually-hidden">Chain of {meta.id} to compare</span>
        <select value={chain.id} onChange={(e) => onChain(e.target.value)}>
          {chains.map((c) => (
            <option key={c.index} value={c.id}>
              Chain {c.id}
            </option>
          ))}
        </select>
        <Icon name="chevron" size={14} />
      </label>
    </div>
  );
}

function VersusRow({ label, a, b, italic = false }: { label: string; a: string; b: string; italic?: boolean }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td>{italic ? <i>{a}</i> : a}</td>
      <td>{italic ? <i>{b}</i> : b}</td>
    </tr>
  );
}
