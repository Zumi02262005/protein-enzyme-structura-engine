/** The two structures picked for comparison. Kept in localStorage so a reload does not lose them. */
import { useSyncExternalStore } from 'react';

const KEY = 'structura.compare';
const MAX = 2;

function load(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string').slice(0, MAX) : [];
  } catch {
    return [];
  }
}

let items: string[] = load();
const listeners = new Set<() => void>();

function commit(next: string[]): void {
  items = next;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* storage can be unavailable (private windows); the tray still works for this visit */
  }
  listeners.forEach((l) => l());
}

export const compareTray = {
  has: (id: string) => items.includes(id),
  /** Add an id, or remove it when it is already there. A third pick replaces the older one. */
  toggle(id: string): void {
    if (items.includes(id)) commit(items.filter((x) => x !== id));
    else commit([...items, id].slice(-MAX));
  },
  remove: (id: string) => commit(items.filter((x) => x !== id)),
  clear: () => commit([]),
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function useCompareTray(): string[] {
  return useSyncExternalStore(subscribe, () => items);
}
