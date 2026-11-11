import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LARGE_STRUCTURE_ATOMS, RcsbError, entryPageUrl, fetchEntry, fetchStructure, formatCount, formatDate, formatResolution, normalizeId, type EntryMeta } from '../api/rcsb';
import { Icon } from '../components/Icon';
import { Segmented } from '../components/Segmented';
import { SequenceStrip } from '../components/SequenceStrip';
import { ErrorNote, Spinner } from '../components/States';
import { StructureCanvas } from '../components/StructureCanvas';
import { Switch } from '../components/Switch';
import type { Chain, Structure } from '../core/types';
import { useAsync, useElementHeight, useMediaQuery } from '../hooks';
import { compareHref } from '../router';
import { compareTray, useCompareTray } from '../state/compareTray';
import { toHex } from '../viewer/palette';
import type { PickHit, Renderer } from '../viewer/renderer';
import { chainColors, describeAtom, residueMarker, type ColorMode, type Layer, type PolymerStyle } from '../viewer/scene';

const STYLES: ReadonlyArray<{ value: PolymerStyle; label: string }> = [
  { value: 'cartoon', label: 'Cartoon' },
  { value: 'tube', label: 'Tube' },
  { value: 'sticks', label: 'Sticks' },
  { value: 'spheres', label: 'Spheres' },
];
type ViewColor = Extract<ColorMode, 'chain' | 'secondary' | 'rainbow' | 'bfactor'>;
const COLORS: ReadonlyArray<{ value: ViewColor; label: string }> = [
  { value: 'chain', label: 'Chain' },
  { value: 'secondary', label: 'Helices and strands' },
  { value: 'rainbow', label: 'Start to end' },
  { value: 'bfactor', label: 'Flexibility (B-factor)' },
];
const PAGE_BACKGROUND = '#16241f';

export function ViewerPage({ id }: { id: string }) {
  const pdbId = normalizeId(id);
  const [retry, setRetry] = useState(0);
  const [allowLarge, setAllowLarge] = useState(false);
  const meta = useAsync(`meta:${pdbId}`, (signal) => fetchEntry(pdbId, signal), retry);
  const atomCount = meta.status === 'ready' ? meta.data.atomCount ?? 0 : 0;
  const needsConfirm = meta.status === 'ready' && atomCount > LARGE_STRUCTURE_ATOMS && !allowLarge;
  const structure = useAsync(meta.status === 'ready' && !needsConfirm ? `cif:${pdbId}` : null, () => fetchStructure(pdbId), retry);

  if (meta.status === 'error') {
    const missing = meta.error instanceof RcsbError && meta.error.kind === 'not-found';
    return (
      <main className="viewer-message">
        <ErrorNote
          title={missing ? `There is no PDB entry called ${pdbId}` : `Could not load ${pdbId}`}
          detail={missing ? 'PDB IDs are four characters, such as 4HHB. Check the ID or search by name instead.' : meta.error.message}
          action={
            missing ? (
              <a className="button" href="#/">
                Back to search
              </a>
            ) : (
              <button type="button" className="button" onClick={() => setRetry((n) => n + 1)}>
                Try again
              </button>
            )
          }
        />
      </main>
    );
  }
  if (meta.status !== 'ready') {
    return (
      <main className="viewer-message">
        <Spinner label={`Looking up ${pdbId}…`} />
      </main>
    );
  }
  if (needsConfirm) {
    return (
      <main className="viewer-message">
        <div className="confirm glass">
          <p className="mono-id">{pdbId}</p>
          <h1 className="confirm-title">{meta.data.title}</h1>
          <p>
            This entry has {formatCount(atomCount)} atoms. Downloading and drawing it can take a while and use a lot of memory, and very large assemblies may not fit in a browser tab at all.
          </p>
          <div className="confirm-actions">
            <button type="button" className="button button-primary" onClick={() => setAllowLarge(true)}>
              Load it anyway
            </button>
            <a className="button" href={entryPageUrl(pdbId)} target="_blank" rel="noreferrer">
              View on RCSB instead
              <Icon name="external" size={15} />
            </a>
          </div>
        </div>
      </main>
    );
  }
  if (structure.status === 'error') {
    return (
      <main className="viewer-message">
        <ErrorNote
          title={`Could not open the coordinates for ${pdbId}`}
          detail={structure.error.message}
          action={
            <button type="button" className="button" onClick={() => setRetry((n) => n + 1)}>
              Try again
            </button>
          }
        />
      </main>
    );
  }
  if (structure.status !== 'ready') {
    return (
      <main className="viewer-message">
        <Spinner label={`Downloading ${pdbId} (${formatCount(atomCount)} atoms)…`} />
      </main>
    );
  }
  return <Viewer meta={meta.data} structure={structure.data} />;
}

function Viewer({ meta, structure }: { meta: EntryMeta; structure: Structure }) {
  const wide = useMediaQuery('(min-width: 1080px)');
  const tray = useCompareTray();
  const inTray = tray.includes(meta.id);

  const [style, setStyle] = useState<PolymerStyle>('cartoon');
  const [color, setColor] = useState<ViewColor>('chain');
  const [showLigands, setShowLigands] = useState(true);
  const [showWater, setShowWater] = useState(false);
  const [spin, setSpin] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<number>>(() => new Set());

  const polymers = useMemo(() => structure.chains.filter((c) => c.kind !== 'other'), [structure]);
  const palette = useMemo(() => chainColors(structure).map(toHex), [structure]);
  const [stripChain, setStripChain] = useState<number>(() => polymers[0]?.index ?? -1);
  const [hovered, setHovered] = useState(-1);
  const [selected, setSelected] = useState(-1);
  const [hoverAtom, setHoverAtom] = useState(-1);

  const hasWater = useMemo(() => structure.residues.some((r) => r.kind === 'water'), [structure]);
  const hasLigands = useMemo(() => structure.residues.some((r) => r.kind === 'ligand' || r.kind === 'ion'), [structure]);

  const layers = useMemo<Layer[]>(
    () => [{ structure, style, color, hiddenChains: new Set(hidden), showLigands, showWater }],
    [structure, style, color, hidden, showLigands, showWater],
  );

  const highlights = useMemo(() => {
    const picks = [selected, hovered].filter((r, i, all) => r >= 0 && all.indexOf(r) === i);
    const out = new Float32Array(picks.length * 4);
    picks.forEach((r, i) => out.set(residueMarker(structure, r), i * 4));
    return out;
  }, [structure, selected, hovered]);

  const rendererRef = useRef<Renderer | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [sequencePanel, sequenceHeight] = useElementHeight<HTMLElement>();

  const onHover = useCallback(
    (hit: PickHit | null, x: number, y: number) => {
      const tip = tooltipRef.current;
      if (tip && hit) {
        tip.style.left = `${x + 16}px`;
        tip.style.top = `${y + 18}px`;
      }
      setHoverAtom(hit ? hit.atom : -1);
      setHovered(hit ? structure.atomResidue[hit.atom] : -1);
    },
    [structure],
  );
  const selectResidue = useCallback(
    (residue: number) => {
      setSelected(residue);
      if (residue < 0) return;
      const chain = structure.chains[structure.residues[residue].chain];
      if (chain.kind !== 'other') setStripChain(chain.index);
      const [x, y, z] = residueMarker(structure, residue);
      rendererRef.current?.focus([x, y, z], 13);
    },
    [structure],
  );
  const onPick = useCallback(
    (hit: PickHit | null) => {
      const residue = hit ? structure.atomResidue[hit.atom] : -1;
      setSelected((current) => (residue === current ? -1 : residue));
      if (residue >= 0) {
        const chain = structure.chains[structure.residues[residue].chain];
        if (chain.kind !== 'other') setStripChain(chain.index);
      }
    },
    [structure],
  );

  // the strip's chain may have been hidden since it was chosen
  useEffect(() => {
    if (stripChain >= 0 && hidden.has(stripChain)) {
      const next = polymers.find((c) => !hidden.has(c.index));
      if (next) setStripChain(next.index);
    }
  }, [hidden, stripChain, polymers]);

  const toggleChain = (index: number) =>
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const saveImage = async () => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    const blob = await renderer.snapshot(PAGE_BACKGROUND);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${meta.id}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  const strip: Chain | undefined = stripChain >= 0 ? structure.chains[stripChain] : undefined;
  const tipResidue = hovered >= 0 ? structure.residues[hovered] : null;
  const tipAtom = hoverAtom >= 0 && tipResidue ? describeAtom(structure, hoverAtom) : null;
  const allHidden = polymers.length > 0 && polymers.every((c) => hidden.has(c.index));

  return (
    <main className="viewer">
      <div className="viewer-stage">
        <StructureCanvas
          layers={layers}
          fitKey={meta.id}
          highlights={highlights}
          spin={spin}
          padding={wide ? { left: 388, right: 316, top: 84, bottom: sequenceHeight + 40 } : undefined}
          label={`Interactive 3D view of ${meta.id}: ${meta.title}`}
          onHover={onHover}
          onPick={onPick}
          onRenderer={(r) => (rendererRef.current = r)}
        />
        {allHidden ? <p className="viewer-empty">Every chain is hidden. Turn one back on in the Molecules list.</p> : null}
      </div>

      <aside className="panel panel-info glass" aria-label="About this structure">
        <div className="panel-scroll">
          <p className="mono-id">{meta.id}</p>
          <h1 className="viewer-title">{meta.title}</h1>
          {meta.keywords ? <p className="viewer-keywords">{meta.keywords}</p> : null}

          <dl className="facts">
            <Fact label="Method" value={meta.method} />
            <Fact label="Resolution" value={formatResolution(meta.resolution)} />
            <Fact label="Released" value={formatDate(meta.released)} />
            <Fact label="Source" value={meta.organisms.slice(0, 3).join(', ')} italic />
            <Fact label="Weight" value={meta.weightKDa === null ? '' : `${meta.weightKDa.toFixed(1)} kDa`} />
            <Fact label="Atoms shown" value={formatCount(structure.atomCount)} />
            {structure.modelCount > 1 ? <Fact label="Models" value={`${structure.modelCount} in the file, showing the first`} /> : null}
          </dl>

          <h2 className="panel-heading">Molecules</h2>
          <ul className="molecules">
            {meta.entities.map((entity) => {
              const chains = polymers.filter((c) => entity.chains.includes(c.id));
              return (
                <li key={entity.id} className="molecule">
                  <p className="molecule-name">{entity.description}</p>
                  <p className="molecule-meta">
                    {[entity.type, entity.length ? `${formatCount(entity.length)} residues` : '', entity.enzyme].filter(Boolean).join(', ')}
                    {entity.organism ? <i>{`, ${entity.organism}`}</i> : null}
                  </p>
                  <div className="chain-chips">
                    {chains.map((c) => (
                      <button key={c.index} type="button" className="chain-chip" aria-pressed={!hidden.has(c.index)} onClick={() => toggleChain(c.index)} title={hidden.has(c.index) ? `Show chain ${c.id}` : `Hide chain ${c.id}`}>
                        <span className="dot" style={{ background: palette[c.index] }} aria-hidden="true" />
                        Chain {c.id}
                      </button>
                    ))}
                    {chains.length === 0 ? <span className="molecule-meta">Not modelled in this file</span> : null}
                  </div>
                </li>
              );
            })}
          </ul>

          {meta.ligands.length > 0 ? (
            <>
              <h2 className="panel-heading">Ligands and ions</h2>
              <ul className="ligands">
                {meta.ligands.map((l) => (
                  <li key={l.id}>
                    <span className="ligand-id">{l.id}</span>
                    <span>{l.name}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {meta.citation ? (
            <>
              <h2 className="panel-heading">Publication</h2>
              <p className="citation-title">{meta.citation.title}</p>
              <p className="citation-meta">
                {meta.citation.authors.slice(0, 3).join(', ')}
                {meta.citation.authors.length > 3 ? ' et al.' : ''}
                {meta.citation.journal ? ` ${meta.citation.journal}` : ''}
                {meta.citation.year ? ` (${meta.citation.year})` : ''}
              </p>
              {meta.citation.doi ? (
                <a className="text-link" href={`https://doi.org/${meta.citation.doi}`} target="_blank" rel="noreferrer">
                  Read the paper
                  <Icon name="external" size={14} />
                </a>
              ) : null}
            </>
          ) : null}

          {structure.ssSource === 'estimated' ? <p className="panel-note">This file does not list helices and strands, so they are estimated from the backbone shape.</p> : null}
        </div>
        <div className="panel-actions">
          <button type="button" className={inTray ? 'button is-on' : 'button'} aria-pressed={inTray} onClick={() => compareTray.toggle(meta.id)}>
            <Icon name={inTray ? 'check' : 'plus'} size={15} />
            {inTray ? 'In comparison' : 'Add to comparison'}
          </button>
          {inTray && tray.length === 2 ? (
            <a className="button button-primary" href={compareHref(tray[0], tray[1])}>
              Compare
            </a>
          ) : (
            <a className="button" href={entryPageUrl(meta.id)} target="_blank" rel="noreferrer">
              RCSB page
              <Icon name="external" size={15} />
            </a>
          )}
        </div>
      </aside>

      <aside className="panel panel-display glass" aria-label="Display options">
        <h2 className="panel-heading">Style</h2>
        <Segmented label="Drawing style" options={STYLES} value={style} onChange={setStyle} />
        <h2 className="panel-heading">Colour by</h2>
        <Segmented label="Colour scheme" options={COLORS} value={color} onChange={setColor} vertical />
        <Legend color={color} />
        <div className="switches">
          <Switch label="Ligands and ions" checked={showLigands && hasLigands} onChange={setShowLigands} disabled={!hasLigands} />
          <Switch label="Water" checked={showWater && hasWater} onChange={setShowWater} disabled={!hasWater} />
          <Switch label="Spin" checked={spin} onChange={setSpin} />
        </div>
        <div className="panel-buttons">
          <button type="button" className="button" onClick={() => rendererRef.current?.resetView()}>
            <Icon name="reset" size={15} />
            Reset view
          </button>
          <button type="button" className="button" onClick={() => void saveImage()}>
            <Icon name="download" size={15} />
            Save image
          </button>
        </div>
        <p className="panel-note">Drag to rotate, scroll to zoom, hold Shift and drag to move. Click a residue to select it, or pick it in the sequence to centre on it.</p>
      </aside>

      {strip ? (
        <section ref={sequencePanel} className="panel panel-sequence glass" aria-label="Sequence">
          <div className="sequence-head">
            <label className="select">
              <span className="visually-hidden">Chain shown in the sequence strip</span>
              <select value={strip.index} onChange={(e) => setStripChain(Number(e.target.value))}>
                {polymers.map((c) => (
                  <option key={c.index} value={c.index} disabled={hidden.has(c.index)}>
                    Chain {c.id}
                  </option>
                ))}
              </select>
              <Icon name="chevron" size={14} />
            </label>
            <span className="sequence-count">{formatCount(strip.sequence.length)} residues modelled</span>
            <span className="sequence-readout" aria-live="polite">
              {selected >= 0 ? `${structure.residues[selected].name} ${structure.residues[selected].seq}${structure.residues[selected].insCode} selected` : ''}
            </span>
          </div>
          <SequenceStrip structure={structure} chain={strip} active={hovered} selected={selected} onHover={setHovered} onSelect={selectResidue} />
        </section>
      ) : null}

      <div ref={tooltipRef} className={tipAtom ? 'tooltip is-visible' : 'tooltip'} role="presentation">
        {tipAtom ? (
          <>
            <strong>
              {tipAtom.residue.kind === 'water' ? 'Water' : `${tipAtom.residue.name} ${tipAtom.residue.seq}${tipAtom.residue.insCode}`}
            </strong>
            <span>
              Chain {tipAtom.chain.id}
              {(style === 'cartoon' || style === 'tube') && tipAtom.residue.trace === hoverAtom ? '' : `, atom ${tipAtom.atomName}`}
            </span>
          </>
        ) : null}
      </div>
    </main>
  );
}

function Fact({ label, value, italic = false }: { label: string; value: string; italic?: boolean }) {
  if (!value) return null;
  return (
    <div className="fact">
      <dt>{label}</dt>
      <dd>{italic ? <i>{value}</i> : value}</dd>
    </div>
  );
}

function Legend({ color }: { color: ViewColor }) {
  if (color === 'secondary') {
    return (
      <ul className="legend">
        <li>
          <span className="dot dot-helix" />
          Helix
        </li>
        <li>
          <span className="dot dot-strand" />
          Strand
        </li>
        <li>
          <span className="dot dot-coil" />
          Loop
        </li>
      </ul>
    );
  }
  if (color === 'rainbow') {
    return (
      <div className="legend-ramp">
        <span>Start</span>
        <span className="ramp ramp-rainbow" />
        <span>End</span>
      </div>
    );
  }
  if (color === 'bfactor') {
    return (
      <div className="legend-ramp">
        <span>Rigid</span>
        <span className="ramp ramp-bfactor" />
        <span>Mobile</span>
      </div>
    );
  }
  return <p className="legend-note">Each chain has its own colour. Ligand carbons are pale; other atoms use element colours.</p>;
}
