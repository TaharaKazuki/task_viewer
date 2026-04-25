import path from 'node:path';
import type { SessionMetaEvent } from '@task-viewer/core';

export type SessionInfo = {
  cwd: string;
  gitBranch: string | null;
  project: string; // display-ready short name
};

export type EnrichedMeta = SessionInfo & { discoveredAt: number };

// Compute a display name from a cwd path. For phase 2 the basename of the
// directory is usually unique and readable. Worktree/collision handling is
// deferred to phase 2 full (see ADR-0004 §5).
export function cwdToProject(cwd: string): string {
  const base = path.basename(cwd);
  return base.length > 0 ? base : cwd;
}

export type ApplyResult = {
  changed: boolean;
  collided: boolean;
};

export class SessionIndex {
  private readonly map = new Map<string, EnrichedMeta>();
  // Track cwds observed per project label. A non-singleton set here means
  // `cwdToProject` collided: two different cwds are sharing the same
  // basename and therefore the same UI project bucket.
  private readonly cwdsByProject = new Map<string, Set<string>>();

  apply(ev: SessionMetaEvent): ApplyResult {
    if (ev.kind !== 'discovered') return { changed: false, collided: false };
    const existing = this.map.get(ev.sessionId);
    if (existing && existing.cwd === ev.cwd && existing.gitBranch === ev.gitBranch) {
      // Idempotent re-discovery (e.g. a subagent JSONL emitting the same
      // parent metadata). Don't log, don't overwrite — silence is the
      // signal that nothing changed.
      return { changed: false, collided: false };
    }
    const project = cwdToProject(ev.cwd);
    const cwds = this.cwdsByProject.get(project) ?? new Set<string>();
    cwds.add(ev.cwd);
    this.cwdsByProject.set(project, cwds);
    const collided = cwds.size > 1;
    if (collided) {
      console.warn(
        `[SessionIndex] project label "${project}" is shared by multiple cwds:`,
        Array.from(cwds),
      );
    }
    this.map.set(ev.sessionId, {
      cwd: ev.cwd,
      gitBranch: ev.gitBranch,
      project,
      discoveredAt: Date.now(),
    });
    return { changed: true, collided };
  }

  get(sessionId: string): SessionInfo | null {
    const hit = this.map.get(sessionId);
    if (!hit) return null;
    return { cwd: hit.cwd, gitBranch: hit.gitBranch, project: hit.project };
  }

  size(): number {
    return this.map.size;
  }
}
