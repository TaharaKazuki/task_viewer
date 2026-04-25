import { useMemo } from 'react';
import { UNKNOWN_PROJECT } from '../types/wire.js';
import { useTodoFiles } from './useTodoFiles.js';

export type ProjectOption = {
  // The value stored in state + localStorage. '' means "all".
  value: string;
  // Display label.
  label: string;
  // How many file entries belong to this project.
  count: number;
};

// Sentinel used for the "all projects" option.
export const ALL_PROJECTS = '';

export function useProjects(): ProjectOption[] {
  const files = useTodoFiles();
  return useMemo(() => {
    const counts = new Map<string, number>();
    for (const path of Object.keys(files)) {
      const file = files[path];
      if (!file) continue;
      counts.set(file.project, (counts.get(file.project) ?? 0) + 1);
    }
    const total = Array.from(counts.values()).reduce((a, b) => a + b, 0);
    const opts: ProjectOption[] = [{ value: ALL_PROJECTS, label: 'All projects', count: total }];
    // Sort named projects by name; pin (Unknown) to the end.
    const named: ProjectOption[] = [];
    let unknown: ProjectOption | null = null;
    for (const [project, count] of counts) {
      const opt = { value: project, label: project, count };
      if (project === UNKNOWN_PROJECT) {
        unknown = opt;
      } else {
        named.push(opt);
      }
    }
    named.sort((a, b) => a.label.localeCompare(b.label));
    opts.push(...named);
    if (unknown) opts.push(unknown);
    return opts;
  }, [files]);
}
