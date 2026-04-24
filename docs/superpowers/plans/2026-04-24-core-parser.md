# core todo-parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship pure-function parsers for `~/.claude/todos/*.json` in a fresh pnpm-workspace monorepo, with zod-backed schema validation and >90% coverage via vitest.

**Architecture:** Single package `packages/core` exports three functions (filename parse, strict content parse, safe content parse) and the corresponding TypeScript types. No filesystem I/O inside the package — callers read the bytes. Watcher, server, web are out of scope.

**Tech Stack:** pnpm@10.30.3 workspaces · TypeScript 5.x (strict) · vitest · zod · biome (lint + format)

---

## Scope

In:
- pnpm workspace skeleton (root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`)
- `packages/core` with `parseTodoFilename` / `parseTodoContent` / `safeParseTodoContent`
- Vitest unit tests covering the 10 edge cases enumerated below

Out:
- `chokidar` watcher (next task)
- `packages/server`, `apps/web` scaffolds
- JSONL parser (Phase 3)

## File Structure

```
task_viewer/
├── package.json                  (new, root, private, scripts: -r typecheck/test/lint/build)
├── pnpm-workspace.yaml           (new)
├── tsconfig.base.json            (new, strict, bundler resolution)
├── biome.json                    (new, minimal)
└── packages/core/
    ├── package.json              (new, name: "@task-viewer/core")
    ├── tsconfig.json             (new, extends base)
    ├── src/
    │   ├── index.ts              (barrel)
    │   └── todo.ts               (types + 3 functions + zod schema)
    └── test/
        └── todo.test.ts          (vitest suite)
```

## Public API (packages/core)

```ts
export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export type TodoItem   = { id: string; content: string; status: TodoStatus };

export type TodoFileMeta = {
  sessionId: string;
  agentId: string;
  isSubagent: boolean;   // sessionId !== agentId
};

export function parseTodoFilename(filename: string): TodoFileMeta | null;
export function parseTodoContent(raw: string): TodoItem[];      // throws on malformed
export function safeParseTodoContent(raw: string): TodoItem[];  // [] on any error
```

## Edge cases to cover (drives tests)

1. Valid filename, sid === aid → `isSubagent: false`
2. Valid filename, sid !== aid → `isSubagent: true`
3. Full path (`/x/y/{uuid}-agent-{uuid}.json`) → extracts basename
4. Missing `.json` extension → `null`
5. Non-UUID shape → `null`
6. Empty array `"[]"` → `[]`
7. Valid array with 3 items → parsed in order
8. Malformed JSON (`"["`) → `parseTodoContent` throws / `safeParseTodoContent` returns `[]`
9. Wrong `status` value (`"done"`) → `parseTodoContent` throws (zod) / `safeParseTodoContent` returns `[]`
10. Write-in-progress truncation (`"[{\"id\":"`) → `safeParseTodoContent` returns `[]`

## Task Breakdown (TDD, bite-sized)

### Task 1: Root scaffold

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`

- [ ] Write minimal root `package.json` with `-r` scripts
- [ ] Write `pnpm-workspace.yaml` listing `packages/*` and `apps/*`
- [ ] Write `tsconfig.base.json` (strict, NodeNext or bundler, `verbatimModuleSyntax`)
- [ ] Write `biome.json` (formatter + linter enabled, recommended rules)
- [ ] `pnpm install` — expect empty lockfile creation to succeed

### Task 2: packages/core package files

**Files:**
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts` (empty barrel), `packages/core/src/todo.ts` (only types for now)

- [ ] Write `packages/core/package.json` with vitest + zod deps
- [ ] Write `packages/core/tsconfig.json` extending base
- [ ] Create empty barrel `src/index.ts`
- [ ] Create `src/todo.ts` with **types only** (no functions yet)
- [ ] `pnpm install` — workspace linking succeeds
- [ ] `pnpm -r typecheck` — passes

### Task 3: parseTodoFilename (TDD)

**Files:**
- Test: `packages/core/test/todo.test.ts`
- Modify: `packages/core/src/todo.ts`

- [ ] Write failing tests for filename cases 1–5
- [ ] Run `pnpm -F @task-viewer/core test` — confirm red
- [ ] Implement `parseTodoFilename` with UUID regex and basename extraction
- [ ] Run tests — confirm green

### Task 4: parseTodoContent (strict, zod) (TDD)

- [ ] Write failing tests for content cases 6, 7, 8, 9
- [ ] Run — confirm red
- [ ] Add zod schema and implement `parseTodoContent` (throws on `JSON.parse` or zod failure)
- [ ] Run tests — confirm green

### Task 5: safeParseTodoContent (TDD)

- [ ] Write failing tests for cases 8, 9, 10 returning `[]`
- [ ] Run — confirm red
- [ ] Implement as try/catch around `parseTodoContent`
- [ ] Run tests — confirm green

### Task 6: Verification and formatting

- [ ] `pnpm -r typecheck` — green
- [ ] `pnpm -r test` — green, coverage >90% on `todo.ts`
- [ ] `pnpm biome check .` — green (or auto-fix + re-check)

### Task 7: code-review skill

- [ ] Invoke code-review skill: verification + adversary review + learnings extraction
- [ ] If Adversary surfaces a non-obvious insight, write `docs/learnings/2026-04-24-*.md`

## Done when

- All 10 test cases pass, typecheck + biome clean
- `packages/core/src/todo.ts` and `index.ts` exist with the public API above
- ADR-0001 on disk (already written)
- Plan file exists (this file)
- code-review block emitted
