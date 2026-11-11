import { useEffect, useRef, useState } from 'react';

export type Async<T> =
  | { status: 'idle'; data: null; error: null }
  | { status: 'loading'; data: null; error: null }
  | { status: 'ready'; data: T; error: null }
  | { status: 'error'; data: null; error: Error };

const IDLE = { status: 'idle', data: null, error: null } as const;
const LOADING = { status: 'loading', data: null, error: null } as const;

/**
 * Run an async task whenever `key` changes. A null key means "nothing to load". Results of an
 * outdated run are dropped, and the task's AbortSignal fires when it is superseded.
 */
export function useAsync<T>(key: string | null, task: (signal: AbortSignal) => Promise<T>, retry = 0): Async<T> {
  const [state, setState] = useState<{ key: string | null; retry: number; value: Async<T> }>({ key: null, retry: 0, value: IDLE });
  const taskRef = useRef(task);
  taskRef.current = task;

  useEffect(() => {
    if (key === null) return;
    const controller = new AbortController();
    let live = true;
    taskRef.current(controller.signal).then(
      (data) => {
        if (live) setState({ key, retry, value: { status: 'ready', data, error: null } });
      },
      (error: unknown) => {
        if (!live || (error instanceof DOMException && error.name === 'AbortError')) return;
        setState({ key, retry, value: { status: 'error', data: null, error: error instanceof Error ? error : new Error(String(error)) } });
      },
    );
    return () => {
      live = false;
      controller.abort();
    };
  }, [key, retry]);

  if (key === null) return IDLE;
  // until the effect for this key reports back, show "loading" rather than a stale result
  return state.key === key && state.retry === retry ? state.value : LOADING;
}

/** True when the user asked the system to minimise animation. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

/** Live height of an element in CSS pixels (0 until it is on the page). */
export function useElementHeight<T extends HTMLElement>(): [(node: T | null) => void, number] {
  const [node, setNode] = useState<T | null>(null);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    if (!node) {
      setHeight(0);
      return;
    }
    const update = () => setHeight(Math.round(node.getBoundingClientRect().height));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);
  return [setNode, height];
}

/** Tracks a CSS media query. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof matchMedia === 'function' && matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, [query]);
  return matches;
}
