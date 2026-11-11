import { useEffect } from 'react';
import { normalizeId } from './api/rcsb';
import { NavBar } from './components/NavBar';
import { ComparePage } from './pages/ComparePage';
import { SearchPage } from './pages/SearchPage';
import { ViewerPage } from './pages/ViewerPage';
import { useRoute } from './router';

export function App() {
  const route = useRoute();

  useEffect(() => {
    document.title = route.name === 'view' ? `${normalizeId(route.id)} – Structura` : route.name === 'compare' ? 'Compare – Structura' : 'Structura';
    if (route.name !== 'search') window.scrollTo(0, 0);
  }, [route]);

  // glass panels catch the light where the pointer is
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const glass = e.target instanceof Element ? e.target.closest<HTMLElement>('.glass') : null;
      if (!glass) return;
      const rect = glass.getBoundingClientRect();
      glass.style.setProperty('--mx', `${e.clientX - rect.left}px`);
      glass.style.setProperty('--my', `${e.clientY - rect.top}px`);
    };
    document.addEventListener('pointermove', onMove, { passive: true });
    return () => document.removeEventListener('pointermove', onMove);
  }, []);

  return (
    <>
      <div className="backdrop" aria-hidden="true">
        <span className="backdrop-glow backdrop-glow-a" />
        <span className="backdrop-glow backdrop-glow-b" />
        <span className="backdrop-glow backdrop-glow-c" />
      </div>
      <NavBar route={route} />
      {route.name === 'view' ? <ViewerPage key={normalizeId(route.id)} id={route.id} /> : route.name === 'compare' ? <ComparePage a={route.a} b={route.b} /> : <SearchPage params={route.params} />}
    </>
  );
}
