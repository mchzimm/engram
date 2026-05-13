/**
 * Multi-layer context cache — project-scoped and persisted in SQLite.
 *
 * Layer 1: Query cache  — per-file context packets / raw string query results.
 * Layer 2: Pattern cache — structural query answers keyed by pattern.
 * Layer 3: Hot file cache — top-N most-accessed files pre-warmed in memory.
 *
 * The database is shared across projects, so every cache layer is scoped by
 * `project_root`. This prevents collisions between repos that happen to share
 * the same relative file paths.
 */
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GraphStore } from "../graph/store.js";

// ─── Types ──────────────────────────────────────────────────────────

export interface CacheEntry {
  readonly key: string;
  readonly result: string;
  readonly filePath: string;
  readonly fileMtime: number;
  readonly createdAt: number;
  readonly hitCount: number;
}

export interface PatternEntry {
  readonly pattern: string;
  readonly result: string;
  readonly graphVersion: number;
  readonly hitCount: number;
}

export interface CacheStats {
  readonly queryEntries: number;
  readonly queryHits: number;
  readonly queryMisses: number;
  readonly patternEntries: number;
  readonly patternHits: number;
  readonly patternMisses: number;
  readonly hotFileCount: number;
  readonly totalHits: number;
  readonly totalMisses: number;
  readonly hitRate: number;
}

interface ProjectCounters {
  queryHits: number;
  queryMisses: number;
  patternHits: number;
  patternMisses: number;
}

interface VersionedResult {
  readonly result: string;
  readonly graphVersion: number;
}

// ─── In-memory LRU ──────────────────────────────────────────────────

class LRUCache<V> {
  private readonly map = new Map<string, V>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): V | undefined {
    const val = this.map.get(key);
    if (val !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, val);
    }
    return val;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    if (this.map.size >= this.maxSize) {
      // Evict oldest (first entry)
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(key, value);
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

// ─── Context Cache ──────────────────────────────────────────────────

export class ContextCache {
  private readonly queryLRUs = new Map<string, LRUCache<string>>();
  private readonly patternLRUs = new Map<string, LRUCache<VersionedResult>>();
  private readonly hotFiles = new Map<string, Set<string>>();
  private readonly counters = new Map<string, ProjectCounters>();

  /**
   * Initialize cache tables in the store. Call once when the store opens.
   * Safe to call multiple times (uses IF NOT EXISTS).
   */
  static ensureTables(store: GraphStore): void {
    store.runSql(`
      CREATE TABLE IF NOT EXISTS query_cache (
        project_root TEXT NOT NULL DEFAULT '',
        key TEXT NOT NULL,
        result TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_mtime REAL NOT NULL,
        created_at INTEGER NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_root, key)
      )
    `);
    store.runSql(`
      CREATE TABLE IF NOT EXISTS pattern_cache (
        project_root TEXT NOT NULL DEFAULT '',
        pattern TEXT NOT NULL,
        result TEXT NOT NULL,
        graph_version INTEGER NOT NULL,
        hit_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (project_root, pattern)
      )
    `);
    store.runSql(
      "CREATE INDEX IF NOT EXISTS idx_query_cache_project_root ON query_cache(project_root)"
    );
    store.runSql(
      "CREATE INDEX IF NOT EXISTS idx_query_cache_file ON query_cache(project_root, file_path)"
    );
    store.runSql(
      "CREATE INDEX IF NOT EXISTS idx_query_cache_project_hits ON query_cache(project_root, hit_count DESC)"
    );
    store.runSql(
      "CREATE INDEX IF NOT EXISTS idx_pattern_cache_project_root ON pattern_cache(project_root)"
    );
    store.runSql(
      "CREATE INDEX IF NOT EXISTS idx_pattern_cache_project_hits ON pattern_cache(project_root, hit_count DESC)"
    );
  }

  // ─── Query Cache (per-file context packets) ─────────────────────

  /**
   * Get a cached context packet for a key. Returns null on miss or if
   * the file has been modified since caching. Optional validator allows
   * callers to reject stale/invalid payloads before the hit is counted.
   */
  getQuery(
    store: GraphStore,
    projectRoot: string,
    filePath: string,
    absPath: string,
    validateResult?: (result: string) => boolean
  ): string | null {
    const root = this.normalizeProjectRoot(projectRoot);
    const currentMtime = this.readMtime(absPath);
    const lru = this.queryLRUFor(root);

    // Check in-memory LRU first.
    const memResult = lru.get(filePath);
    if (memResult !== undefined) {
      if (
        currentMtime !== null &&
        this.queryRowIsCurrent(store, root, filePath, currentMtime, memResult, validateResult)
      ) {
        this.incrementQueryHit(root, store, filePath);
        return memResult;
      }
      lru.delete(filePath);
    }

    // Check SQLite.
    const entry = this.getQueryEntry(store, root, filePath);
    if (!entry) {
      this.countersFor(root).queryMisses += 1;
      return null;
    }

    if (
      currentMtime === null ||
      entry.fileMtime !== currentMtime ||
      !this.validateResult(entry.result, validateResult)
    ) {
      this.invalidateFile(store, root, filePath);
      this.countersFor(root).queryMisses += 1;
      return null;
    }

    lru.set(filePath, entry.result);
    this.incrementQueryHit(root, store, filePath);
    return entry.result;
  }

  /**
   * Store a resolved context packet for a key.
   */
  setQuery(
    store: GraphStore,
    projectRoot: string,
    filePath: string,
    absPath: string,
    result: string
  ): void {
    const root = this.normalizeProjectRoot(projectRoot);
    const mtime = this.readMtime(absPath);
    if (mtime === null) return;

    store.runSql(
      `INSERT OR REPLACE INTO query_cache
       (project_root, key, result, file_path, file_mtime, created_at, hit_count)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [root, filePath, result, filePath, mtime, Date.now()]
    );
    this.queryLRUFor(root).set(filePath, result);
  }

  // ─── Pattern Cache (structural queries) ─────────────────────────

  /**
   * Get a cached answer for a structural query pattern.
   */
  getPattern(
    store: GraphStore,
    projectRoot: string,
    pattern: string,
    graphVersion: number
  ): string | null {
    const root = this.normalizeProjectRoot(projectRoot);
    const lru = this.patternLRUFor(root);

    // In-memory first.
    const memResult = lru.get(pattern);
    if (memResult !== undefined) {
      if (memResult.graphVersion === graphVersion) {
        this.incrementPatternHit(root, store, pattern);
        return memResult.result;
      }
      lru.delete(pattern);
    }

    // SQLite.
    const entry = this.getPatternEntry(store, root, pattern);
    if (!entry) {
      this.countersFor(root).patternMisses += 1;
      return null;
    }
    if (entry.graphVersion !== graphVersion) {
      this.invalidatePatternRow(store, root, pattern);
      this.countersFor(root).patternMisses += 1;
      return null;
    }

    lru.set(pattern, { result: entry.result, graphVersion: entry.graphVersion });
    this.incrementPatternHit(root, store, pattern);
    return entry.result;
  }

  /**
   * Cache a structural query result.
   */
  setPattern(
    store: GraphStore,
    projectRoot: string,
    pattern: string,
    result: string,
    graphVersion: number
  ): void {
    const root = this.normalizeProjectRoot(projectRoot);
    store.runSql(
      `INSERT OR REPLACE INTO pattern_cache
       (project_root, pattern, result, graph_version, hit_count)
       VALUES (?, ?, ?, ?, 0)`,
      [root, pattern, result, graphVersion]
    );
    this.patternLRUFor(root).set(pattern, { result, graphVersion });
  }

  // ─── Hot File Cache ─────────────────────────────────────────────

  /**
   * Pre-warm hot files from access frequency data.
   * Call at SessionStart to eliminate first-hit latency.
   */
  warmHotFiles(store: GraphStore, projectRoot: string, topN = 20): number {
    const root = this.normalizeProjectRoot(projectRoot);
    const stmt = store.prepare(
      `SELECT file_path, result, file_mtime
       FROM query_cache
       WHERE project_root = ?
       ORDER BY hit_count DESC
       LIMIT ?`
    );
    stmt.bind([root, topN]);
    let count = 0;
    while (stmt.step()) {
      const row = stmt.getAsObject();
      const filePath = row.file_path as string;
      const result = row.result as string;
      const cachedMtime = row.file_mtime as number;

      try {
        const absPath = join(root, filePath);
        const currentMtime = this.readMtime(absPath);
        if (currentMtime !== null && cachedMtime === currentMtime) {
          this.queryLRUFor(root).set(filePath, result);
          this.hotFilesFor(root).add(filePath);
          count += 1;
        }
      } catch {
        // File gone — skip.
      }
    }
    stmt.free();
    return count;
  }

  // ─── Invalidation ───────────────────────────────────────────────

  /** Invalidate all cache entries for a specific file. */
  invalidateFile(store: GraphStore, projectRoot: string, filePath: string): void {
    const root = this.normalizeProjectRoot(projectRoot);
    store.runSql(
      "DELETE FROM query_cache WHERE project_root = ? AND file_path = ?",
      [root, filePath]
    );
    this.queryLRUFor(root).delete(filePath);
    this.hotFilesFor(root).delete(filePath);
  }

  /** Invalidate all pattern cache entries (on graph mutation). */
  invalidatePatterns(store: GraphStore, projectRoot: string): void {
    const root = this.normalizeProjectRoot(projectRoot);
    store.runSql("DELETE FROM pattern_cache WHERE project_root = ?", [root]);
    this.patternLRUFor(root).clear();
  }

  /** Clear all caches completely for a project. */
  clearAll(store: GraphStore, projectRoot: string): void {
    const root = this.normalizeProjectRoot(projectRoot);
    store.runSql("DELETE FROM query_cache WHERE project_root = ?", [root]);
    store.runSql("DELETE FROM pattern_cache WHERE project_root = ?", [root]);
    this.queryLRUFor(root).clear();
    this.patternLRUFor(root).clear();
    this.hotFilesFor(root).clear();
    this.counters.set(root, {
      queryHits: 0,
      queryMisses: 0,
      patternHits: 0,
      patternMisses: 0,
    });
  }

  // ─── Stats ──────────────────────────────────────────────────────

  getStats(store: GraphStore, projectRoot?: string): CacheStats {
    if (projectRoot === undefined) {
      return this.getAggregateStats(store);
    }
    return this.getProjectStats(store, projectRoot);
  }

  private getProjectStats(store: GraphStore, projectRoot: string): CacheStats {
    const root = this.normalizeProjectRoot(projectRoot);
    let queryEntries = 0;
    let patternEntries = 0;
    let persistedQueryHits = 0;
    let persistedPatternHits = 0;

    try {
      const stmt1 = store.prepare(
        "SELECT COUNT(*) as cnt, COALESCE(SUM(hit_count), 0) as hits FROM query_cache WHERE project_root = ?"
      );
      stmt1.bind([root]);
      if (stmt1.step()) {
        const row = stmt1.getAsObject();
        queryEntries = row.cnt as number;
        persistedQueryHits = row.hits as number;
      }
      stmt1.free();
    } catch {
      // Table may not exist yet.
    }

    try {
      const stmt2 = store.prepare(
        "SELECT COUNT(*) as cnt, COALESCE(SUM(hit_count), 0) as hits FROM pattern_cache WHERE project_root = ?"
      );
      stmt2.bind([root]);
      if (stmt2.step()) {
        const row = stmt2.getAsObject();
        patternEntries = row.cnt as number;
        persistedPatternHits = row.hits as number;
      }
      stmt2.free();
    } catch {
      // Table may not exist yet.
    }

    const counters = this.countersFor(root);

    // Merge in-process counters with persisted totals. SQLite `hit_count`
    // accumulates across sessions; we prefer the larger of the two to show
    // cross-session activity without double-counting the current session.
    const queryHits = Math.max(counters.queryHits, persistedQueryHits);
    const patternHits = Math.max(counters.patternHits, persistedPatternHits);

    const totalHits = queryHits + patternHits;
    const totalMisses = counters.queryMisses + counters.patternMisses;
    const total = totalHits + totalMisses;

    return {
      queryEntries,
      queryHits,
      queryMisses: counters.queryMisses,
      patternEntries,
      patternHits,
      patternMisses: counters.patternMisses,
      hotFileCount: this.hotFilesFor(root).size,
      totalHits,
      totalMisses,
      hitRate: total > 0 ? totalHits / total : 0,
    };
  }

  private getAggregateStats(store: GraphStore): CacheStats {
    let queryEntries = 0;
    let patternEntries = 0;
    let persistedQueryHits = 0;
    let persistedPatternHits = 0;

    try {
      const stmt1 = store.prepare(
        "SELECT COUNT(*) as cnt, COALESCE(SUM(hit_count), 0) as hits FROM query_cache"
      );
      if (stmt1.step()) {
        const row = stmt1.getAsObject();
        queryEntries = row.cnt as number;
        persistedQueryHits = row.hits as number;
      }
      stmt1.free();
    } catch {
      // Table may not exist yet.
    }

    try {
      const stmt2 = store.prepare(
        "SELECT COUNT(*) as cnt, COALESCE(SUM(hit_count), 0) as hits FROM pattern_cache"
      );
      if (stmt2.step()) {
        const row = stmt2.getAsObject();
        patternEntries = row.cnt as number;
        persistedPatternHits = row.hits as number;
      }
      stmt2.free();
    } catch {
      // Table may not exist yet.
    }

    let queryHits = 0;
    let queryMisses = 0;
    let patternHits = 0;
    let patternMisses = 0;
    let hotFileCount = 0;
    for (const counters of this.counters.values()) {
      queryHits += counters.queryHits;
      queryMisses += counters.queryMisses;
      patternHits += counters.patternHits;
      patternMisses += counters.patternMisses;
    }
    for (const files of this.hotFiles.values()) {
      hotFileCount += files.size;
    }

    // Merge in-process counters with persisted totals. SQLite `hit_count`
    // accumulates across sessions; we prefer the larger of the two to show
    // cross-session activity without double-counting the current session.
    queryHits = Math.max(queryHits, persistedQueryHits);
    patternHits = Math.max(patternHits, persistedPatternHits);

    const totalHits = queryHits + patternHits;
    const totalMisses = queryMisses + patternMisses;
    const total = totalHits + totalMisses;

    return {
      queryEntries,
      queryHits,
      queryMisses,
      patternEntries,
      patternHits,
      patternMisses,
      hotFileCount,
      totalHits,
      totalMisses,
      hitRate: total > 0 ? totalHits / total : 0,
    };
  }

  // ─── Private helpers ────────────────────────────────────────────

  private normalizeProjectRoot(projectRoot: string): string {
    return projectRoot ? resolve(projectRoot) : projectRoot;
  }

  private queryLRUFor(projectRoot: string): LRUCache<string> {
    const root = this.normalizeProjectRoot(projectRoot);
    let lru = this.queryLRUs.get(root);
    if (!lru) {
      lru = new LRUCache<string>(100);
      this.queryLRUs.set(root, lru);
    }
    return lru;
  }

  private patternLRUFor(projectRoot: string): LRUCache<VersionedResult> {
    const root = this.normalizeProjectRoot(projectRoot);
    let lru = this.patternLRUs.get(root);
    if (!lru) {
      lru = new LRUCache<VersionedResult>(50);
      this.patternLRUs.set(root, lru);
    }
    return lru;
  }

  private hotFilesFor(projectRoot: string): Set<string> {
    const root = this.normalizeProjectRoot(projectRoot);
    let files = this.hotFiles.get(root);
    if (!files) {
      files = new Set<string>();
      this.hotFiles.set(root, files);
    }
    return files;
  }

  private countersFor(projectRoot: string): ProjectCounters {
    const root = this.normalizeProjectRoot(projectRoot);
    let counters = this.counters.get(root);
    if (!counters) {
      counters = {
        queryHits: 0,
        queryMisses: 0,
        patternHits: 0,
        patternMisses: 0,
      };
      this.counters.set(root, counters);
    }
    return counters;
  }

  private readMtime(absPath: string): number | null {
    try {
      return statSync(absPath).mtimeMs;
    } catch {
      return null;
    }
  }

  private validateResult(
    result: string,
    validateResult?: (result: string) => boolean
  ): boolean {
    if (!validateResult) return true;
    try {
      return validateResult(result);
    } catch {
      return false;
    }
  }

  private queryRowIsCurrent(
    store: GraphStore,
    projectRoot: string,
    filePath: string,
    currentMtime: number,
    result: string,
    validateResult?: (result: string) => boolean
  ): boolean {
    const entry = this.getQueryEntry(store, projectRoot, filePath);
    if (!entry) return false;
    return entry.fileMtime === currentMtime && this.validateResult(result, validateResult);
  }

  private getQueryEntry(
    store: GraphStore,
    projectRoot: string,
    filePath: string
  ): CacheEntry | null {
    const root = this.normalizeProjectRoot(projectRoot);
    try {
      const stmt = store.prepare(
        "SELECT * FROM query_cache WHERE project_root = ? AND key = ?"
      );
      stmt.bind([root, filePath]);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return {
          key: row.key as string,
          result: row.result as string,
          filePath: row.file_path as string,
          fileMtime: row.file_mtime as number,
          createdAt: row.created_at as number,
          hitCount: row.hit_count as number,
        };
      }
      stmt.free();
    } catch {
      // Table may not exist yet.
    }
    return null;
  }

  private getPatternEntry(
    store: GraphStore,
    projectRoot: string,
    pattern: string
  ): PatternEntry | null {
    const root = this.normalizeProjectRoot(projectRoot);
    try {
      const stmt = store.prepare(
        "SELECT * FROM pattern_cache WHERE project_root = ? AND pattern = ?"
      );
      stmt.bind([root, pattern]);
      if (stmt.step()) {
        const row = stmt.getAsObject();
        stmt.free();
        return {
          pattern: row.pattern as string,
          result: row.result as string,
          graphVersion: row.graph_version as number,
          hitCount: row.hit_count as number,
        };
      }
      stmt.free();
    } catch {
      // Table may not exist yet.
    }
    return null;
  }

  private incrementQueryHit(
    projectRoot: string,
    store: GraphStore,
    filePath: string
  ): void {
    const root = this.normalizeProjectRoot(projectRoot);
    const counters = this.countersFor(root);
    counters.queryHits += 1;
    try {
      store.runSql(
        "UPDATE query_cache SET hit_count = hit_count + 1 WHERE project_root = ? AND key = ?",
        [root, filePath]
      );
    } catch {
      // Non-critical.
    }
  }

  private incrementPatternHit(
    projectRoot: string,
    store: GraphStore,
    pattern: string
  ): void {
    const root = this.normalizeProjectRoot(projectRoot);
    const counters = this.countersFor(root);
    counters.patternHits += 1;
    try {
      store.runSql(
        "UPDATE pattern_cache SET hit_count = hit_count + 1 WHERE project_root = ? AND pattern = ?",
        [root, pattern]
      );
    } catch {
      // Non-critical.
    }
  }

  private invalidatePatternRow(
    store: GraphStore,
    projectRoot: string,
    pattern: string
  ): void {
    const root = this.normalizeProjectRoot(projectRoot);
    try {
      store.runSql(
        "DELETE FROM pattern_cache WHERE project_root = ? AND pattern = ?",
        [root, pattern]
      );
    } catch {
      // Non-critical.
    }
    this.patternLRUFor(root).delete(pattern);
  }
}

/** Singleton cache instance shared across the session. */
let _instance: ContextCache | null = null;

export function getContextCache(): ContextCache {
  if (!_instance) {
    _instance = new ContextCache();
  }
  return _instance;
}

/** Reset the singleton (for tests). */
export function _resetContextCache(): void {
  _instance = null;
}
