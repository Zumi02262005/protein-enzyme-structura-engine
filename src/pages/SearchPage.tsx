import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchEntries, fetchStructure, formatCount, looksLikePdbId, normalizeId, searchEntries, type EntryMeta, type MethodFilter, type SortOrder } from '../api/rcsb';
import { CompareTray } from '../components/CompareTray';
import { Icon } from '../components/Icon';
import { ResultCard } from '../components/ResultCard';
import { Segmented } from '../components/Segmented';
import { ErrorNote, Spinner } from '../components/States';
import { StructureCanvas } from '../components/StructureCanvas';
import { useAsync, useMediaQuery } from '../hooks';
import { navigate, searchHref } from '../router';
import { useCompareTray } from '../state/compareTray';
import type { Layer } from '../viewer/scene';

const PAGE = 24;
const HERO_ID = '4HHB';
const FEATURED = ['4HHB', '1MBN', '2LYZ', '1EMA', '1BNA', '4INS', '2RH1', '6VXX'];
const EXAMPLES = ['hemoglobin', 'CRISPR Cas9', 'green fluorescent protein', 'ATP synthase', '6VXX'];

const METHODS: ReadonlyArray<{ value: MethodFilter | 'any'; label: string }> = [
  { value: 'any', label: 'Any method' },
  { value: 'xray', label: 'X-ray' },
  { value: 'em', label: 'Cryo-EM' },
  { value: 'nmr', label: 'NMR' },
];
const RESOLUTIONS = [
  { value: '', label: 'Any resolution' },
  { value: '1.5', label: '1.5 Å or better' },
  { value: '2', label: '2.0 Å or better' },
  { value: '3', label: '3.0 Å or better' },
  { value: '4', label: '4.0 Å or better' },
];
const SORTS: ReadonlyArray<{ value: SortOrder; label: string }> = [
  { value: 'score', label: 'Best match' },
  { value: 'newest', label: 'Newest' },
  { value: 'resolution', label: 'Sharpest' },
];

interface Found {
  total: number;
  metas: EntryMeta[];
}

export function SearchPage({ params }: { params: URLSearchParams }) {
  const query = params.get('q') ?? '';
  const methodParam = params.get('method') ?? '';
  const method: MethodFilter = methodParam === 'xray' || methodParam === 'em' || methodParam === 'nmr' ? methodParam : '';
  const resParam = params.get('res') ?? '';
  const maxResolution = RESOLUTIONS.some((r) => r.value === resParam && r.value) ? Number(resParam) : null;
  const sortParam = params.get('sort') ?? '';
  const sort: SortOrder = sortParam === 'newest' || sortParam === 'resolution' ? sortParam : 'score';

  const wide = useMediaQuery('(min-width: 900px)');
  const [text, setText] = useState(query);
  useEffect(() => setText(query), [query]);

  const go = (next: { q?: string; method?: string; res?: string; sort?: string }) =>
    navigate(searchHref({ q: next.q ?? query, method: next.method ?? method, res: next.res ?? (maxResolution === null ? '' : resParam), sort: (next.sort ?? sort) === 'score' ? '' : next.sort ?? sort }));
  const submit = (e: { preventDefault(): void }) => {
    e.preventDefault();
    go({ q: text.trim() });
  };

  const active = query.trim() !== '';
  const queryKey = active ? JSON.stringify([query.trim(), method, maxResolution, sort]) : null;

  // "Show more" grows the page count for the current query only
  const [more, setMore] = useState({ key: '', pages: 1 });
  const pages = queryKey !== null && more.key === queryKey ? more.pages : 1;
  const [retry, setRetry] = useState(0);

  const search = useAsync<Found>(
    queryKey === null ? null : `${queryKey}#${pages}`,
    async (signal) => {
      const result = await searchEntries({ query, method, maxResolution, sort, start: 0, rows: pages * PAGE }, signal);
      const metas = await fetchEntries(result.ids, signal);
      return { total: result.total, metas };
    },
    retry,
  );
  // keep showing the previous page of the same query while the next one loads
  const last = useRef<{ key: string; data: Found } | null>(null);
  if (search.status === 'ready' && queryKey !== null) last.current = { key: queryKey, data: search.data };
  const found = search.status === 'ready' ? search.data : last.current && last.current.key === queryKey ? last.current.data : null;

  const idQuery = active && looksLikePdbId(query) ? normalizeId(query) : null;
  const exact = useAsync(idQuery, (signal) => fetchEntries([idQuery ?? ''], signal));
  const exactMeta = exact.status === 'ready' ? exact.data[0] ?? null : null;

  const featured = useAsync(active ? null : 'featured', (signal) => fetchEntries(FEATURED, signal), retry);
  const tray = useCompareTray();

  const listed = useMemo(() => {
    if (!found) return [];
    return exactMeta ? found.metas.filter((m) => m.id !== exactMeta.id) : found.metas;
  }, [found, exactMeta]);

  return (
    <main className={active ? 'search' : 'search search-home'}>
      {active ? null : <Hero />}
      <section className="search-head">
        {active ? null : (
          <>
            <h1 className="hero-title">
              Search the Protein
              <br />
              Data Bank in 3D
            </h1>
            <p className="hero-lede">Find any experimentally solved structure, turn it over in your hands, and lay two on top of each other to see where they differ.</p>
          </>
        )}
        <form className="searchbar glass" onSubmit={submit} role="search">
          <Icon name="search" size={20} />
          <input
            className="searchbar-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Protein name, organism, ligand or PDB ID"
            aria-label="Search the Protein Data Bank"
            spellCheck={false}
            autoComplete="off"
            autoFocus={!active && wide}
          />
          {text ? (
            <button type="button" className="searchbar-clear" onClick={() => setText('')} aria-label="Clear the search box">
              <Icon name="close" size={16} />
            </button>
          ) : null}
          <button type="submit" className="button button-primary">
            Search
          </button>
        </form>
        {active ? (
          <div className="filters">
            <Segmented label="Experimental method" options={METHODS} value={method || 'any'} onChange={(v) => go({ method: v === 'any' ? '' : v })} />
            <label className="select glass">
              <span className="visually-hidden">Resolution</span>
              <select value={maxResolution === null ? '' : resParam} onChange={(e) => go({ res: e.target.value })}>
                {RESOLUTIONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
              <Icon name="chevron" size={14} />
            </label>
            <Segmented label="Sort results" options={SORTS} value={sort} onChange={(v) => go({ sort: v })} />
          </div>
        ) : (
          <div className="examples">
            <span className="examples-label">Try</span>
            {EXAMPLES.map((ex) => (
              <a key={ex} className="chip" href={searchHref({ q: ex })}>
                {ex}
              </a>
            ))}
          </div>
        )}
      </section>

      {active ? (
        <section className="results" aria-live="polite" aria-busy={search.status === 'loading'}>
          {search.status === 'error' ? (
            <ErrorNote
              title="The search did not go through"
              detail={search.error.message}
              action={
                <button type="button" className="button" onClick={() => setRetry((n) => n + 1)}>
                  Try again
                </button>
              }
            />
          ) : null}
          {found ? (
            <>
              <p className="results-count">
                {found.total === 0 && !exactMeta
                  ? `No structures match “${query}” with these filters.`
                  : `${formatCount(Math.max(found.total, exactMeta ? 1 : 0))} ${found.total === 1 ? 'structure' : 'structures'} for “${query}”`}
              </p>
              {found.total === 0 && !exactMeta ? <p className="results-hint">Check the spelling, try a broader term, or loosen the method and resolution filters.</p> : null}
              <div className="grid">
                {exactMeta ? <ResultCard meta={exactMeta} inTray={tray.includes(exactMeta.id)} exact /> : null}
                {listed.map((m) => (
                  <ResultCard key={m.id} meta={m} inTray={tray.includes(m.id)} />
                ))}
              </div>
              {found.metas.length < found.total ? (
                <div className="results-more">
                  <button type="button" className="button" disabled={search.status === 'loading'} onClick={() => queryKey !== null && setMore({ key: queryKey, pages: pages + 1 })}>
                    {search.status === 'loading' ? 'Loading…' : `Show ${Math.min(PAGE, found.total - found.metas.length)} more`}
                  </button>
                </div>
              ) : null}
            </>
          ) : search.status === 'loading' ? (
            <Spinner label={`Searching for “${query}”…`} />
          ) : null}
        </section>
      ) : (
        <section className="results">
          <h2 className="section-title">Structures worth a first look</h2>
          {featured.status === 'loading' ? <Spinner label="Loading structures…" /> : null}
          {featured.status === 'error' ? (
            <ErrorNote
              title="Could not load the starter structures"
              detail={featured.error.message}
              action={
                <button type="button" className="button" onClick={() => setRetry((n) => n + 1)}>
                  Try again
                </button>
              }
            />
          ) : null}
          {featured.status === 'ready' ? (
            <div className="grid">
              {featured.data.map((m) => (
                <ResultCard key={m.id} meta={m} inTray={tray.includes(m.id)} />
              ))}
            </div>
          ) : null}
        </section>
      )}
      <CompareTray />
    </main>
  );
}

/** A live, slowly turning haemoglobin behind the search box. Purely decorative. */
function Hero() {
  const wide = useMediaQuery('(min-width: 900px)');
  const structure = useAsync(wide ? HERO_ID : null, () => fetchStructure(HERO_ID));
  const layers = useMemo<Layer[] | null>(
    () => (structure.status === 'ready' ? [{ structure: structure.data, style: 'cartoon', color: 'chain', showLigands: true, showWater: false }] : null),
    [structure.status, structure.data],
  );
  if (!wide) return null;
  return (
    <div className={layers ? 'hero-stage is-ready' : 'hero-stage'} aria-hidden="true">
      <StructureCanvas layers={layers} fitKey={HERO_ID} spin interactive={false} label="" />
    </div>
  );
}
