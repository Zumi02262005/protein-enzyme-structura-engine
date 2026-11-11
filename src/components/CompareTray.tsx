import { compareHref } from '../router';
import { compareTray, useCompareTray } from '../state/compareTray';
import { Icon } from './Icon';

/** Floating dock that collects the two structures to compare. */
export function CompareTray() {
  const items = useCompareTray();
  if (items.length === 0) return null;
  return (
    <aside className="tray glass" aria-label="Structures picked for comparison">
      <span className="tray-label">Compare</span>
      {[0, 1].map((slot) => {
        const id = items[slot];
        return id ? (
          <span key={slot} className="tray-slot is-filled">
            <span className={slot === 0 ? 'dot dot-a' : 'dot dot-b'} aria-hidden="true" />
            {id}
            <button type="button" className="tray-remove" onClick={() => compareTray.remove(id)} aria-label={`Remove ${id} from the comparison`}>
              <Icon name="close" size={13} />
            </button>
          </span>
        ) : (
          <span key={slot} className="tray-slot">
            Pick one more
          </span>
        );
      })}
      {items.length === 2 ? (
        <a className="button button-primary" href={compareHref(items[0], items[1])}>
          Compare structures
        </a>
      ) : (
        <span className="button button-primary is-disabled" aria-disabled="true">
          Compare structures
        </span>
      )}
    </aside>
  );
}
