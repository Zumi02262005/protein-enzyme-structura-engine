import { useState } from 'react';
import { looksLikePdbId, normalizeId } from '../api/rcsb';
import { compareHref, navigate, searchHref, viewHref, type Route } from '../router';
import { useCompareTray } from '../state/compareTray';
import { Icon } from './Icon';

export function NavBar({ route }: { route: Route }) {
  const tray = useCompareTray();
  const [quick, setQuick] = useState('');

  const submit = (e: { preventDefault(): void }) => {
    e.preventDefault();
    const text = quick.trim();
    if (!text) return;
    navigate(looksLikePdbId(text) ? viewHref(normalizeId(text)) : searchHref({ q: text }));
    setQuick('');
  };

  return (
    <header className={route.name === 'search' ? 'nav' : 'nav nav-wide'}>
      <a className="nav-brand" href="#/" aria-label="Structura, home">
        <svg className="nav-mark" viewBox="8 6 48 52" width="28" height="30" aria-hidden="true">
          <path d="M44 17c-13-6-26 1-24 10 1 6 8 7 13 8 6 1 12 3 11 9-1 8-14 11-25 4" fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" />
          <circle cx="44" cy="17" r="5" fill="var(--mist)" />
          <circle cx="19" cy="48" r="5" fill="var(--lichen)" />
        </svg>
        <span className="nav-word">Structura</span>
      </a>
      <nav className="nav-tabs glass" aria-label="Sections">
        <a className="nav-tab" href="#/" aria-current={route.name === 'search' ? 'page' : undefined}>
          <Icon name="search" size={16} />
          Search
        </a>
        <a className="nav-tab" href={route.name === 'compare' ? compareHref(route.a, route.b) : compareHref(tray[0], tray[1])} aria-current={route.name === 'compare' ? 'page' : undefined}>
          <Icon name="compare" size={16} />
          Compare
        </a>
        {route.name === 'view' ? (
          <span className="nav-tab" aria-current="page">
            <Icon name="molecule" size={16} />
            {normalizeId(route.id)}
          </span>
        ) : null}
      </nav>
      {route.name === 'search' ? (
        <span className="nav-spacer" />
      ) : (
        <form className="nav-quick glass" onSubmit={submit} role="search">
          <Icon name="search" size={16} />
          <input value={quick} onChange={(e) => setQuick(e.target.value)} placeholder="PDB ID or keyword" aria-label="Open a PDB ID or search by keyword" spellCheck={false} autoComplete="off" />
        </form>
      )}
    </header>
  );
}
