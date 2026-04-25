import type { ChangeEvent } from 'react';
import { useProjects } from '../hooks/useProjects.js';

export type ProjectDropdownProps = {
  value: string;
  onChange: (value: string) => void;
};

export function ProjectDropdown({ value, onChange }: ProjectDropdownProps) {
  const options = useProjects();
  const handleChange = (e: ChangeEvent<HTMLSelectElement>) => onChange(e.target.value);
  // If a previously-selected value (e.g., restored from localStorage) no
  // longer matches any current project, show it as an "unavailable" option
  // so the dropdown doesn't render a blank/mismatched state.
  const hasCurrent = options.some((o) => o.value === value);
  return (
    <label className="flex items-center gap-2 text-xs text-slate-700">
      <span className="font-medium">Project</span>
      <select
        value={value}
        onChange={handleChange}
        className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-medium shadow-sm focus:border-sky-500 focus:outline-none"
      >
        {!hasCurrent && (
          <option value={value} disabled>
            {value} (no files)
          </option>
        )}
        {options.map((o) => (
          <option key={o.value || '__all__'} value={o.value}>
            {o.label} ({o.count} {o.count === 1 ? 'file' : 'files'})
          </option>
        ))}
      </select>
    </label>
  );
}
