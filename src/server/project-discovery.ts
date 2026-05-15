import { existsSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export interface DiscoveredProjectRoot {
  readonly root: string;
  readonly lastModified: number;
}

export const PROJECTS_ROOT_ENV = "ENGRAM_PROJECTS_ROOT_DIR";
export const DEFAULT_PROJECTS_ROOT = join(homedir(), "prjs");
export const PROJECT_DISCOVERY_MAX_DEPTH_ENV = "ENGRAM_PROJECT_DISCOVERY_MAX_DEPTH";

const DEFAULT_MAX_DEPTH = 3;

const IGNORED_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  "target",
  "tmp",
  "temp",
  ".tmp",
  ".cache",
  ".next",
  ".turbo",
  ".vite",
  ".parcel-cache",
  ".venv",
  ".venv311-acestep",
  ".venv311-tangoflux",
  ".venv314-voices",
  ".venv314-image",
  ".venv310-heartmula",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".idea",
  ".vscode",
  "bin",
  "obj",
]);

function parseMaxDepth(value: string | undefined): number {
  if (!value) return DEFAULT_MAX_DEPTH;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_MAX_DEPTH;
}

function listDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeStatMtime(path: string): number {
  try {
    return statSync(path).mtimeMs || 0;
  } catch {
    return 0;
  }
}

function isIgnorableDirName(name: string): boolean {
  const lower = name.toLowerCase();
  return IGNORED_DIR_NAMES.has(name) || IGNORED_DIR_NAMES.has(lower);
}

function markIfExists(path: string, state: { found: boolean; lastModified: number }): void {
  if (!existsSync(path)) return;
  state.found = true;
  state.lastModified = Math.max(state.lastModified, safeStatMtime(path));
}

function candidateHasMemorySignals(dir: string, entries: Dirent[]): { found: boolean; lastModified: number } {
  const state = { found: false, lastModified: 0 };
  const byName = new Map(entries.map((entry) => [entry.name, entry] as const));

  const engramDir = byName.get(".engram");
  if (engramDir?.isDirectory()) {
    markIfExists(join(dir, ".engram", "graph.db"), state);
    markIfExists(join(dir, ".engram", "hook-log.jsonl"), state);
  }

  const piDir = byName.get(".pi");
  if (piDir?.isDirectory()) {
    markIfExists(join(dir, ".pi", "settings.json"), state);
  }

  const memoryMd = byName.get("MEMORY.md");
  if (memoryMd?.isFile()) {
    markIfExists(join(dir, "MEMORY.md"), state);
  }

  const obsidianDir = byName.get(".obsidian");
  if (obsidianDir?.isDirectory()) {
    markIfExists(join(dir, ".obsidian"), state);
  }

  const projectKnowledgeDir = byName.get("Project Knowledge");
  if (projectKnowledgeDir?.isDirectory()) {
    markIfExists(join(dir, "Project Knowledge"), state);
  }

  const memoryDir = byName.get("Memory") || byName.get("memory");
  if (memoryDir?.isDirectory()) {
    markIfExists(join(dir, memoryDir.name), state);
  }

  for (const entry of entries) {
    if (!entry.isFile() && !entry.isDirectory()) continue;
    const lower = entry.name.toLowerCase();
    if (lower.endsWith(".mem")) {
      markIfExists(join(dir, entry.name), state);
    }
  }

  return state;
}

function scanWorkspaceDir(
  dir: string,
  depth: number,
  maxDepth: number,
  seen: Map<string, number>
): void {
  const entries = listDir(dir);
  if (entries.length === 0) return;

  const marker = candidateHasMemorySignals(dir, entries);
  if (marker.found) {
    const prev = seen.get(dir) ?? 0;
    seen.set(dir, Math.max(prev, marker.lastModified));
    return;
  }

  if (depth >= maxDepth) return;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (isIgnorableDirName(entry.name)) continue;
    scanWorkspaceDir(join(dir, entry.name), depth + 1, maxDepth, seen);
  }
}

function toSortedArray(seen: Map<string, number>): DiscoveredProjectRoot[] {
  return [...seen.entries()]
    .map(([root, lastModified]) => ({ root, lastModified }))
    .sort((a, b) => b.lastModified - a.lastModified || a.root.localeCompare(b.root));
}

/**
 * Discover project roots that already have local memory artifacts under a workspace tree.
 * Best-effort only: directory errors are skipped and the scan never throws.
 */
export function discoverProjectsWithMemories(
  workspaceRoot = process.env[PROJECTS_ROOT_ENV] || DEFAULT_PROJECTS_ROOT,
  maxDepth = parseMaxDepth(process.env[PROJECT_DISCOVERY_MAX_DEPTH_ENV])
): DiscoveredProjectRoot[] {
  try {
    const root = resolve(workspaceRoot);
    if (!existsSync(root)) return [];

    const seen = new Map<string, number>();
    const rootEntries = listDir(root);
    const rootMarker = candidateHasMemorySignals(root, rootEntries);
    if (rootMarker.found) {
      seen.set(root, rootMarker.lastModified);
    }

    if (maxDepth <= 0) return toSortedArray(seen);

    for (const entry of rootEntries) {
      if (!entry.isDirectory()) continue;
      if (isIgnorableDirName(entry.name)) continue;
      scanWorkspaceDir(join(root, entry.name), 1, maxDepth, seen);
    }

    return toSortedArray(seen);
  } catch {
    return [];
  }
}
