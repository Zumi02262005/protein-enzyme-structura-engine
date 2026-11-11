import type { ReactNode } from 'react';
import { Icon } from './Icon';

export function Spinner({ label }: { label: string }) {
  return (
    <div className="state" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function ErrorNote({ title, detail, action }: { title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="state state-error" role="alert">
      <Icon name="warning" size={22} />
      <div>
        <p className="state-title">{title}</p>
        {detail ? <p className="state-detail">{detail}</p> : null}
        {action ? <div className="state-action">{action}</div> : null}
      </div>
    </div>
  );
}
