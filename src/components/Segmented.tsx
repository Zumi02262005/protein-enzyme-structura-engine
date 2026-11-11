import type { CSSProperties } from 'react';

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  label: string;
  options: ReadonlyArray<SegmentOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Stack the options in a column instead of a row. */
  vertical?: boolean;
}

/** A row of mutually exclusive choices with a glass thumb that slides to the selected one. */
export function Segmented<T extends string>({ label, options, value, onChange, vertical = false }: Props<T>) {
  const index = Math.max(0, options.findIndex((o) => o.value === value));
  const style = { '--count': options.length, '--index': index } as CSSProperties;
  return (
    <div className={vertical ? 'segmented segmented-vertical' : 'segmented'} role="radiogroup" aria-label={label} style={style}>
      <span className="segmented-thumb" aria-hidden="true" />
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className="segmented-option" onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
