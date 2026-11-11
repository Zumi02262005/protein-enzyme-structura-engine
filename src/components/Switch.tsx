interface Props {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}

export function Switch({ label, checked, onChange, disabled = false }: Props) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="switch" disabled={disabled} onClick={() => onChange(!checked)}>
      <span className="switch-label">{label}</span>
      <span className="switch-track" aria-hidden="true">
        <span className="switch-knob" />
      </span>
    </button>
  );
}
