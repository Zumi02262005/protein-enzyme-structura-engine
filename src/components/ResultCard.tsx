import { useState } from 'react';
import { formatResolution, formatYear, imageUrl, type EntryMeta } from '../api/rcsb';
import { viewHref } from '../router';
import { compareTray } from '../state/compareTray';
import { Icon } from './Icon';

interface Props {
  meta: EntryMeta;
  inTray: boolean;
  /** Marks the card that matched a typed PDB ID exactly. */
  exact?: boolean;
}

export function ResultCard({ meta, inTray, exact = false }: Props) {
  const [imageFailed, setImageFailed] = useState(false);
  const facts = [meta.methodShort, formatResolution(meta.resolution), formatYear(meta.released)].filter(Boolean);
  return (
    <article className={exact ? 'card glass card-exact' : 'card glass'}>
      <a className="card-link" href={viewHref(meta.id)} aria-label={`Open ${meta.id} in 3D: ${meta.title}`}>
        <div className="card-thumb">
          {imageFailed ? (
            <Icon name="molecule" size={44} />
          ) : (
            <img src={imageUrl(meta.id)} alt="" loading="lazy" decoding="async" onError={() => setImageFailed(true)} />
          )}
        </div>
        <div className="card-body">
          <p className="card-id">
            {meta.id}
            {exact ? <span className="card-flag">Exact ID match</span> : null}
          </p>
          <h3 className="card-title">{meta.title}</h3>
          {meta.organisms.length > 0 ? <p className="card-organism">{meta.organisms.slice(0, 2).join(', ')}</p> : null}
          <ul className="card-facts">
            {facts.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      </a>
      <button type="button" className={inTray ? 'card-compare is-on' : 'card-compare'} aria-pressed={inTray} onClick={() => compareTray.toggle(meta.id)}>
        <Icon name={inTray ? 'check' : 'plus'} size={15} />
        {inTray ? 'In comparison' : 'Compare'}
      </button>
    </article>
  );
}
