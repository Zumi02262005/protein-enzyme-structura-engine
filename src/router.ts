/**
 * Tiny hash router. Routes live after the "#" so the app works from any static server:
 *
 *   #/                         search (query and filters as ?q=…&method=…)
 *   #/view/4HHB                3D viewer
 *   #/compare/4HHB.A/1MBN.A    comparison (chain after the dot is optional)
 */
import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'search'; params: URLSearchParams }
  | { name: 'view'; id: string }
  | { name: 'compare'; a: string; b: string };

function parse(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const [path, query = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
  if (parts[0] === 'view' && parts[1]) return { name: 'view', id: parts[1] };
  if (parts[0] === 'compare') return { name: 'compare', a: parts[1] ?? '', b: parts[2] ?? '' };
  return { name: 'search', params: new URLSearchParams(query) };
}

const subscribe = (notify: () => void) => {
  window.addEventListener('hashchange', notify);
  return () => window.removeEventListener('hashchange', notify);
};
const snapshot = () => window.location.hash;

let cachedHash: string | null = null;
let cachedRoute: Route = { name: 'search', params: new URLSearchParams() };

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, snapshot);
  if (hash !== cachedHash) {
    cachedHash = hash;
    cachedRoute = parse(hash);
  }
  return cachedRoute;
}

export function navigate(hash: string, replace = false): void {
  if (replace) {
    const url = window.location.pathname + window.location.search + hash;
    window.history.replaceState(null, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else window.location.hash = hash;
}

export const viewHref = (id: string) => `#/view/${encodeURIComponent(id)}`;

export function compareHref(a = '', b = ''): string {
  if (!a && !b) return '#/compare';
  return `#/compare/${encodeURIComponent(a || '-')}/${encodeURIComponent(b || '-')}`;
}

export function searchHref(params: Record<string, string>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `#/?${s}` : '#/';
}

/** "4HHB.A" → { id: "4HHB", chain: "A" }. A lone "-" stands for an empty slot. */
export function parseSlot(text: string): { id: string; chain: string } {
  if (!text || text === '-') return { id: '', chain: '' };
  const dot = text.indexOf('.');
  return dot === -1 ? { id: text, chain: '' } : { id: text.slice(0, dot), chain: text.slice(dot + 1) };
}

export function formatSlot(id: string, chain: string): string {
  return id ? (chain ? `${id}.${chain}` : id) : '';
}
