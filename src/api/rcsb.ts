/**
 * Client for the public RCSB Protein Data Bank services. No API key is needed and every endpoint
 * allows cross-origin requests, so the browser talks to RCSB directly:
 *
 *   search.rcsb.org   full-text and attribute search → PDB ids
 *   data.rcsb.org     GraphQL metadata for a set of ids
 *   files.rcsb.org    coordinate files (mmCIF)
 *   cdn.rcsb.org      pre-rendered preview images
 */
import { parseStructure } from '../core/mmcif';
import type { Structure } from '../core/types';

const SEARCH_URL = 'https://search.rcsb.org/rcsbsearch/v2/query';
const GRAPHQL_URL = 'https://data.rcsb.org/graphql';
const FILES_URL = 'https://files.rcsb.org/download';
const IMAGE_URL = 'https://cdn.rcsb.org/images/structures';

/* ------------------------------------------------------------------ types */

export type MethodFilter = '' | 'xray' | 'em' | 'nmr';
export type SortOrder = 'score' | 'newest' | 'resolution';

export interface SearchOptions {
  query: string;
  method: MethodFilter;
  /** Keep entries at this resolution (Å) or better; null for any. */
  maxResolution: number | null;
  sort: SortOrder;
  start: number;
  rows: number;
}

export interface SearchResult {
  total: number;
  ids: string[];
}

export interface PolymerEntity {
  id: string;
  description: string;
  /** "Protein", "DNA", "RNA", ... */
  type: string;
  length: number;
  /** Author chain ids of every copy of this molecule. */
  chains: string[];
  organism: string;
  /** Enzyme Commission number and name, when the molecule is an enzyme. */
  enzyme: string;
}

export interface LigandInfo {
  id: string;
  name: string;
  formula: string;
}

export interface Citation {
  title: string;
  journal: string;
  year: number | null;
  doi: string;
  authors: string[];
}

export interface EntryMeta {
  id: string;
  title: string;
  /** Full method name, e.g. "X-ray diffraction". */
  method: string;
  /** Short label, e.g. "X-ray". */
  methodShort: string;
  resolution: number | null;
  released: string | null;
  keywords: string;
  organisms: string[];
  weightKDa: number | null;
  atomCount: number | null;
  modelCount: number | null;
  residueCount: number | null;
  entities: PolymerEntity[];
  ligands: LigandInfo[];
  citation: Citation | null;
}

export class RcsbError extends Error {
  constructor(message: string, readonly kind: 'network' | 'not-found' | 'server' = 'server') {
    super(message);
    this.name = 'RcsbError';
  }
}

/* ------------------------------------------------------------------ helpers */

async function request(url: string, init: RequestInit | undefined, what: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new RcsbError(`Could not reach RCSB to ${what}. Check your internet connection and try again.`, 'network');
  }
  return response;
}

/** PDB ids are four characters starting with a digit; the extended form is "pdb_" plus eight. */
export function looksLikePdbId(text: string): boolean {
  return /^(?:[0-9][A-Za-z0-9]{3}|pdb_[0-9A-Za-z]{8})$/i.test(text.trim());
}

export function normalizeId(text: string): string {
  const t = text.trim();
  return /^pdb_/i.test(t) ? t.toLowerCase() : t.toUpperCase();
}

const ACRONYMS = new Set(['DNA', 'RNA', 'ATP', 'ADP', 'AMP', 'GTP', 'GDP', 'NAD', 'NADH', 'NADP', 'FAD', 'FMN', 'HIV', 'NMR', 'SARS', 'MHC', 'HLA', 'TRNA', 'MRNA', 'RRNA', 'GFP', 'CRISPR', 'II', 'III', 'IV', 'VI', 'VII', 'IGG', 'FAB', 'TCR', 'GPCR', 'PDZ', 'SH2', 'SH3', 'COA', 'UDP', 'CDK', 'MAP', 'ER', 'EM', 'ABC']);

/** Old entries shout their titles in capitals; turn those into sentence case, keeping acronyms. */
export function tidyTitle(title: string): string {
  const t = title.trim().replace(/\s+/g, ' ');
  // leave mixed-case text alone, and sequence notation such as 5'-D(*CP*GP*CP*G)-3'
  if (!t || /[a-z]/.test(t) || t.includes('*')) return t;
  const lowered = t.replace(/[A-Za-z0-9']+/g, (word) => {
    if (ACRONYMS.has(word) || /\d/.test(word) || (word.length === 1 && word !== 'A')) return word;
    return word.toLowerCase();
  });
  // capital letter at the start and after each full stop
  return lowered.replace(/(^|[.!?]\s+)([a-z])/g, (_, lead: string, letter: string) => lead + letter.toUpperCase());
}

const SMALL_WORDS = new Set(['OF', 'IN', 'TO', 'BY', 'ON', 'OR', 'AT', 'AS']);

/**
 * Same idea for ligand names, but chemistry-aware: one- and two-letter tokens are usually element
 * symbols, stereo labels or numerals (N-ACETYL-D-GLUCOSAMINE, PROTOPORPHYRIN IX CONTAINING FE).
 */
export function tidyChemicalName(name: string): string {
  const t = name.trim().replace(/\s+/g, ' ');
  if (!t || /[a-z]/.test(t)) return t;
  const lowered = t.replace(/[A-Za-z]+/g, (word) => (word.length <= 2 && !SMALL_WORDS.has(word) ? word : word.toLowerCase()));
  return lowered.replace(/^([^A-Za-z]*)([a-z])/, (_, lead: string, letter: string) => lead + letter.toUpperCase());
}

const METHOD_SHORT: Record<string, string> = {
  'X-RAY DIFFRACTION': 'X-ray',
  'ELECTRON MICROSCOPY': 'Cryo-EM',
  'SOLUTION NMR': 'NMR',
  'SOLID-STATE NMR': 'Solid-state NMR',
  'NEUTRON DIFFRACTION': 'Neutron',
  'ELECTRON CRYSTALLOGRAPHY': 'Electron crystallography',
  'FIBER DIFFRACTION': 'Fibre diffraction',
  'SOLUTION SCATTERING': 'Solution scattering',
};

const METHOD_ATTRIBUTE: Record<Exclude<MethodFilter, ''>, string> = {
  xray: 'X-RAY DIFFRACTION',
  em: 'ELECTRON MICROSCOPY',
  nmr: 'SOLUTION NMR',
};

/* ------------------------------------------------------------------ search */

export async function searchEntries(options: SearchOptions, signal?: AbortSignal): Promise<SearchResult> {
  const text = options.query.trim();
  const nodes: unknown[] = [];
  if (text) nodes.push({ type: 'terminal', service: 'full_text', parameters: { value: text } });
  if (options.method) {
    nodes.push({ type: 'terminal', service: 'text', parameters: { attribute: 'exptl.method', operator: 'exact_match', value: METHOD_ATTRIBUTE[options.method] } });
  }
  if (options.maxResolution !== null) {
    nodes.push({ type: 'terminal', service: 'text', parameters: { attribute: 'rcsb_entry_info.resolution_combined', operator: 'less_or_equal', value: options.maxResolution } });
  }
  if (nodes.length === 0) return { total: 0, ids: [] };

  const sort =
    options.sort === 'newest'
      ? [{ sort_by: 'rcsb_accession_info.initial_release_date', direction: 'desc' }]
      : options.sort === 'resolution'
        ? [{ sort_by: 'rcsb_entry_info.resolution_combined', direction: 'asc' }]
        : [{ sort_by: 'score', direction: 'desc' }];

  const body = {
    query: { type: 'group', logical_operator: 'and', nodes },
    return_type: 'entry',
    request_options: { paginate: { start: options.start, rows: options.rows }, results_content_type: ['experimental'], sort },
  };
  const response = await request(SEARCH_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal }, 'search');
  if (response.status === 204) return { total: 0, ids: [] }; // RCSB answers "no content" when nothing matches
  if (!response.ok) {
    let detail = '';
    try {
      detail = ((await response.json()) as { message?: string }).message ?? '';
    } catch {
      /* the body was not JSON */
    }
    throw new RcsbError(detail ? `RCSB could not run this search: ${detail}` : `RCSB search failed (HTTP ${response.status}).`);
  }
  const json = (await response.json()) as { total_count?: number; result_set?: Array<{ identifier: string }> };
  return { total: json.total_count ?? 0, ids: (json.result_set ?? []).map((r) => r.identifier) };
}

/* ------------------------------------------------------------------ metadata */

const ENTRY_QUERY = `query ($ids: [String!]!) {
  entries(entry_ids: $ids) {
    rcsb_id
    struct { title }
    exptl { method }
    struct_keywords { pdbx_keywords }
    rcsb_entry_info {
      resolution_combined
      molecular_weight
      deposited_atom_count
      deposited_model_count
      deposited_polymer_monomer_count
    }
    rcsb_accession_info { initial_release_date }
    rcsb_primary_citation { title journal_abbrev year pdbx_database_id_DOI rcsb_authors }
    polymer_entities {
      rcsb_id
      entity_poly { rcsb_entity_polymer_type rcsb_sample_sequence_length }
      rcsb_polymer_entity { pdbx_description rcsb_ec_lineage { id name } }
      rcsb_entity_source_organism { ncbi_scientific_name }
      rcsb_polymer_entity_container_identifiers { auth_asym_ids }
    }
    nonpolymer_entities { nonpolymer_comp { chem_comp { id name formula } } }
  }
}`;

interface RawEntry {
  rcsb_id: string;
  struct: { title: string | null } | null;
  exptl: Array<{ method: string | null }> | null;
  struct_keywords: { pdbx_keywords: string | null } | null;
  rcsb_entry_info: {
    resolution_combined: number[] | null;
    molecular_weight: number | null;
    deposited_atom_count: number | null;
    deposited_model_count: number | null;
    deposited_polymer_monomer_count: number | null;
  } | null;
  rcsb_accession_info: { initial_release_date: string | null } | null;
  rcsb_primary_citation: { title: string | null; journal_abbrev: string | null; year: number | null; pdbx_database_id_DOI: string | null; rcsb_authors: string[] | null } | null;
  polymer_entities: Array<{
    rcsb_id: string;
    entity_poly: { rcsb_entity_polymer_type: string | null; rcsb_sample_sequence_length: number | null } | null;
    rcsb_polymer_entity: { pdbx_description: string | null; rcsb_ec_lineage: Array<{ id: string | null; name: string | null }> | null } | null;
    rcsb_entity_source_organism: Array<{ ncbi_scientific_name: string | null }> | null;
    rcsb_polymer_entity_container_identifiers: { auth_asym_ids: string[] | null } | null;
  }> | null;
  nonpolymer_entities: Array<{ nonpolymer_comp: { chem_comp: { id: string | null; name: string | null; formula: string | null } | null } | null }> | null;
}

function toMeta(raw: RawEntry): EntryMeta {
  const methodRaw = raw.exptl?.[0]?.method ?? '';
  const organisms: string[] = [];
  const entities: PolymerEntity[] = (raw.polymer_entities ?? []).map((e) => {
    const organism = e.rcsb_entity_source_organism?.find((o) => o.ncbi_scientific_name)?.ncbi_scientific_name ?? '';
    if (organism && !organisms.includes(organism)) organisms.push(organism);
    const lineage = e.rcsb_polymer_entity?.rcsb_ec_lineage ?? [];
    const leaf = lineage.length ? lineage[lineage.length - 1] : null;
    return {
      id: e.rcsb_id,
      description: tidyTitle(e.rcsb_polymer_entity?.pdbx_description ?? 'Unnamed molecule'),
      type: e.entity_poly?.rcsb_entity_polymer_type ?? 'Polymer',
      length: e.entity_poly?.rcsb_sample_sequence_length ?? 0,
      chains: e.rcsb_polymer_entity_container_identifiers?.auth_asym_ids ?? [],
      organism,
      enzyme: leaf?.id ? `EC ${leaf.id}${leaf.name ? ' ' + leaf.name : ''}` : '',
    };
  });
  entities.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  const ligands: LigandInfo[] = [];
  for (const n of raw.nonpolymer_entities ?? []) {
    const c = n.nonpolymer_comp?.chem_comp;
    if (c?.id && !ligands.some((l) => l.id === c.id)) ligands.push({ id: c.id, name: tidyChemicalName(c.name ?? c.id), formula: c.formula ?? '' });
  }

  const cite = raw.rcsb_primary_citation;
  const methodFull = methodRaw ? (methodRaw.charAt(0) + methodRaw.slice(1).toLowerCase()).replace(/nmr/g, 'NMR') : 'Unknown method';
  return {
    id: raw.rcsb_id,
    title: tidyTitle(raw.struct?.title ?? raw.rcsb_id),
    method: methodFull,
    methodShort: METHOD_SHORT[methodRaw] ?? (methodRaw ? methodFull : 'Unknown'),
    resolution: raw.rcsb_entry_info?.resolution_combined?.[0] ?? null,
    released: raw.rcsb_accession_info?.initial_release_date ?? null,
    keywords: tidyTitle(raw.struct_keywords?.pdbx_keywords ?? ''),
    organisms,
    weightKDa: raw.rcsb_entry_info?.molecular_weight ?? null,
    atomCount: raw.rcsb_entry_info?.deposited_atom_count ?? null,
    modelCount: raw.rcsb_entry_info?.deposited_model_count ?? null,
    residueCount: raw.rcsb_entry_info?.deposited_polymer_monomer_count ?? null,
    entities,
    ligands,
    citation: cite?.title
      ? { title: cite.title, journal: cite.journal_abbrev ?? '', year: cite.year ?? null, doi: cite.pdbx_database_id_DOI ?? '', authors: cite.rcsb_authors ?? [] }
      : null,
  };
}

const metaCache = new Map<string, EntryMeta>();

/** Metadata for a list of ids, in the same order. Ids RCSB does not know are left out. */
export async function fetchEntries(ids: string[], signal?: AbortSignal): Promise<EntryMeta[]> {
  const wanted = ids.map(normalizeId);
  const missing = wanted.filter((id) => !metaCache.has(id));
  if (missing.length > 0) {
    const response = await request(GRAPHQL_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: ENTRY_QUERY, variables: { ids: missing } }), signal }, 'load structure details');
    if (!response.ok) throw new RcsbError(`RCSB could not return structure details (HTTP ${response.status}).`);
    const json = (await response.json()) as { data?: { entries?: Array<RawEntry | null> | null }; errors?: Array<{ message: string }> };
    if (!json.data?.entries) throw new RcsbError(json.errors?.[0]?.message ?? 'RCSB returned an unexpected answer.');
    for (const raw of json.data.entries) if (raw) metaCache.set(normalizeId(raw.rcsb_id), toMeta(raw));
  }
  return wanted.map((id) => metaCache.get(id)).filter((m): m is EntryMeta => m !== undefined);
}

export async function fetchEntry(id: string, signal?: AbortSignal): Promise<EntryMeta> {
  const [meta] = await fetchEntries([id], signal);
  if (!meta) throw new RcsbError(`RCSB has no entry called ${normalizeId(id)}.`, 'not-found');
  return meta;
}

/* ------------------------------------------------------------------ coordinates */

/** Structures above this many atoms ask for confirmation before downloading. */
export const LARGE_STRUCTURE_ATOMS = 250_000;

const structureCache = new Map<string, Promise<Structure>>();
const CACHE_SIZE = 6;

/** Download and parse the coordinates of one entry. Recent results are kept in memory. */
export function fetchStructure(id: string): Promise<Structure> {
  const key = normalizeId(id);
  const cached = structureCache.get(key);
  if (cached) {
    // refresh its place in the queue
    structureCache.delete(key);
    structureCache.set(key, cached);
    return cached;
  }
  const promise = (async () => {
    const response = await request(`${FILES_URL}/${key}.cif`, undefined, 'download the structure');
    if (response.status === 404) throw new RcsbError(`RCSB has no coordinate file for ${key}.`, 'not-found');
    if (!response.ok) throw new RcsbError(`RCSB could not send the coordinates for ${key} (HTTP ${response.status}).`);
    const text = await response.text();
    return parseStructure(text, key);
  })();
  structureCache.set(key, promise);
  promise.catch(() => structureCache.delete(key));
  while (structureCache.size > CACHE_SIZE) {
    const oldest = structureCache.keys().next().value;
    if (oldest === undefined) break;
    structureCache.delete(oldest);
  }
  return promise;
}

export function imageUrl(id: string): string {
  return `${IMAGE_URL}/${normalizeId(id).toLowerCase()}_assembly-1.jpeg`;
}

export function modelImageUrl(id: string): string {
  return `${IMAGE_URL}/${normalizeId(id).toLowerCase()}_model-1.jpeg`;
}

export function entryPageUrl(id: string): string {
  return `https://www.rcsb.org/structure/${normalizeId(id)}`;
}

export function fileUrl(id: string): string {
  return `${FILES_URL}/${normalizeId(id)}.cif`;
}

/* ------------------------------------------------------------------ formatting */

export function formatResolution(value: number | null): string {
  return value === null ? '' : `${value.toFixed(2)} Å`;
}

export function formatYear(iso: string | null): string {
  return iso ? iso.slice(0, 4) : '';
}

export function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}
