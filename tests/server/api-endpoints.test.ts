/**
 * Integration tests for the new dashboard API endpoints added in
 * v2.0 Phase 1. Boots an in-process HTTP server per-test and exercises
 * each route.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { init, getStore } from "../../src/core.js";
import {
  ContextCache,
  getContextCache,
  _resetContextCache,
} from "../../src/intelligence/cache.js";
import { buildDashboardHtml } from "../../src/server/ui.js";

// Find a free port
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const addr = s.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      s.close(() => resolve(port));
    });
  });
}

const TEST_TOKEN = "api-endpoints-test-token-abcdef0123456789abcdef0123456789";

async function fetchJson(url: string): Promise<{ status: number; body: unknown }> {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${TEST_TOKEN}` },
  });
  const body = r.headers.get("content-type")?.includes("json")
    ? await r.json()
    : await r.text();
  return { status: r.status, body };
}

describe("HTTP API — dashboard endpoints", () => {
  let testDir: string;
  let otherDir: string;
  let port: number;

  beforeAll(async () => {
    process.env.ENGRAM_API_TOKEN = TEST_TOKEN;
    testDir = join(tmpdir(), `engram-api-${Date.now()}`);
    process.env.ENGRAM_GLOBAL_DB_PATH = join(testDir, ".engram", "memory.db");
    _resetContextCache();

    mkdirSync(join(testDir, "src"), { recursive: true });
    writeFileSync(
      join(testDir, "src", "app.ts"),
      "export function hello() { return 42; }\n"
    );
    await init(testDir);

    // Seed a separate project so accumulative cache stats are non-zero even
    // when the test project's own cache is empty.
    otherDir = join(tmpdir(), `engram-api-cache-${Date.now()}`);
    mkdirSync(join(otherDir, ".engram"), { recursive: true });
    mkdirSync(join(otherDir, "src"), { recursive: true });
    const otherFile = join(otherDir, "src", "other.ts");
    writeFileSync(otherFile, "export const other = 123;\n");
    const otherStore = await getStore(otherDir);
    ContextCache.ensureTables(otherStore);
    try {
      const cache = getContextCache();
      cache.setQuery(otherStore, otherDir, "src/other.ts", otherFile, "cached other summary");
      cache.getQuery(otherStore, otherDir, "src/other.ts", otherFile);
      cache.getQuery(otherStore, otherDir, "src/missing.ts", join(otherDir, "src", "missing.ts"));
      cache.setPattern(otherStore, otherDir, "what does other export?", "other is exported from other.ts", 1);
      cache.getPattern(otherStore, otherDir, "what does other export?", 1);
      cache.getPattern(otherStore, otherDir, "missing pattern", 1);
      cache.warmHotFiles(otherStore, otherDir, 20);
    } finally {
      otherStore.close();
    }

    port = await freePort();

    const { createHttpServer } = await import("../../src/server/http.js");
    await createHttpServer(testDir, port);

    // Give the server a moment to fully bind
    await new Promise((r) => setTimeout(r, 50));
  });

  afterAll(async () => {
    // Server is kept alive until process exit — test isolation via unique ports
    _resetContextCache();
    rmSync(otherDir, { recursive: true, force: true });
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.ENGRAM_API_TOKEN;
    delete process.env.ENGRAM_GLOBAL_DB_PATH;
  });

  describe("existing endpoints", () => {
    it("GET /health returns version + uptime", async () => {
      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/health`);
      expect(status).toBe(200);
      expect((body as { ok: boolean }).ok).toBe(true);
      expect(body).toHaveProperty("version");
      expect(body).toHaveProperty("uptime");
    });

    it("GET /stats returns node/edge counts", async () => {
      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/stats`);
      expect(status).toBe(200);
      expect(body).toHaveProperty("nodes");
      expect(body).toHaveProperty("edges");
    });
  });

  describe("new dashboard endpoints", () => {
    it("GET /api/hook-log returns paginated entries", async () => {
      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/api/hook-log`);
      expect(status).toBe(200);
      expect(body).toHaveProperty("entries");
      expect(body).toHaveProperty("total");
      expect(Array.isArray((body as { entries: unknown[] }).entries)).toBe(true);
    });

    it("GET /api/hook-log/summary returns byEvent/byTool/byDecision", async () => {
      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/api/hook-log/summary`);
      expect(status).toBe(200);
      expect(body).toHaveProperty("byEvent");
      expect(body).toHaveProperty("byTool");
      expect(body).toHaveProperty("byDecision");
    });

    it("GET /api/tokens returns cumulative stats", async () => {
      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/api/tokens`);
      expect(status).toBe(200);
      expect(body).toHaveProperty("totalSessions");
      expect(body).toHaveProperty("totalSaved");
      expect(body).toHaveProperty("avgReduction");
    });

    it("GET /api/files/heatmap returns sorted file list", async () => {
      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/api/files/heatmap`);
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
    });

    it("GET /api/providers/health returns component status", async () => {
      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/api/providers/health`);
      expect(status).toBe(200);
      expect(body).toBeTypeOf("object");
    });

    it("GET /api/cache/stats returns current-project cache metrics", async () => {
      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/api/cache/stats`);
      expect(status).toBe(200);
      const b = body as {
        queryEntries: number;
        queryHits: number;
        queryMisses: number;
        patternEntries: number;
        patternHits: number;
        patternMisses: number;
        hotFileCount: number;
        totalHits: number;
        totalMisses: number;
        hitRate: number;
      };
      expect(b.queryEntries).toBe(0);
      expect(b.queryHits).toBe(0);
      expect(b.queryMisses).toBe(0);
      expect(b.patternEntries).toBe(0);
      expect(b.patternHits).toBe(0);
      expect(b.patternMisses).toBe(0);
      expect(b.hotFileCount).toBe(0);
      expect(b.totalHits).toBe(0);
      expect(b.totalMisses).toBe(0);
      expect(b.hitRate).toBe(0);
    });

    it("GET /api/cache/stats?scope=accumulative returns aggregated cache metrics", async () => {
      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/api/cache/stats?scope=accumulative`);
      expect(status).toBe(200);
      const b = body as {
        queryEntries: number;
        queryHits: number;
        queryMisses: number;
        patternEntries: number;
        patternHits: number;
        patternMisses: number;
        hotFileCount: number;
        totalHits: number;
        totalMisses: number;
        hitRate: number;
      };
      expect(b.queryEntries).toBeGreaterThan(0);
      expect(b.queryHits).toBeGreaterThan(0);
      expect(b.queryMisses).toBeGreaterThan(0);
      expect(b.patternEntries).toBeGreaterThan(0);
      expect(b.patternHits).toBeGreaterThan(0);
      expect(b.patternMisses).toBeGreaterThan(0);
      expect(b.hotFileCount).toBeGreaterThan(0);
      expect(b.totalHits).toBeGreaterThan(0);
      expect(b.totalMisses).toBeGreaterThan(0);
      expect(b.hitRate).toBeGreaterThan(0);
    });

    it("GET /api/graph/nodes returns paginated nodes", async () => {
      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/api/graph/nodes?limit=50`);
      expect(status).toBe(200);
      expect(body).toHaveProperty("nodes");
      expect(body).toHaveProperty("total");
      const b = body as { nodes: Array<{ sourceFile?: string; metadata?: Record<string, unknown> }>; total: number };
      expect(Array.isArray(b.nodes)).toBe(true);
      expect(b.nodes.length).toBeLessThanOrEqual(50);
      const appNode = b.nodes.find((n) => typeof n.sourceFile === "string" && n.sourceFile.endsWith("app.ts"));
      expect(appNode).toBeDefined();
      expect(appNode?.metadata?.fileMtimeMs).toEqual(expect.any(Number));
      expect(appNode?.metadata?.fileBirthtimeMs).toEqual(expect.any(Number));
    });

    it("GET /api/graph/god-nodes returns top nodes", async () => {
      const { status, body } = await fetchJson(`http://127.0.0.1:${port}/api/graph/god-nodes`);
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      const nodes = body as Array<{ node?: { sourceFile?: string; metadata?: Record<string, unknown> } }>;
      const appNode = nodes.find((n) => typeof n.node?.sourceFile === "string" && n.node.sourceFile.endsWith("app.ts"));
      expect(appNode?.node?.metadata?.fileMtimeMs).toEqual(expect.any(Number));
    });
  });

  describe("dashboard HTML (/ui)", () => {
    it("GET /ui returns valid HTML with security headers", async () => {
      const r = await fetch(`http://127.0.0.1:${port}/ui`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(r.headers.get("cache-control")).toBe("no-cache");

      const body = await r.text();
      expect(body).toContain("<!DOCTYPE html>");
      expect(body).toContain("Content-Security-Policy");
      expect(body).toContain('id="tab-overview"');
      expect(body).toContain('id="tab-graph"');
    });

    it("GET /ui/ (trailing slash) also serves dashboard", async () => {
      const r = await fetch(`http://127.0.0.1:${port}/ui/`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
    });

    it("GET /ui?token=<t> redirects and sets cookie (browser bootstrap)", async () => {
      const r = await fetch(`http://127.0.0.1:${port}/ui?token=${TEST_TOKEN}`, {
        redirect: "manual",
      });
      expect(r.status).toBe(302);
      expect(r.headers.get("location")).toBe("/ui");
      const sc = r.headers.get("set-cookie") ?? "";
      expect(sc).toMatch(/engram_token=/);
      expect(sc).toMatch(/HttpOnly/i);
    });

    it("GET /ui?token=<wrong> falls through to 401", async () => {
      const r = await fetch(`http://127.0.0.1:${port}/ui?token=not-the-real-token`, {
        redirect: "manual",
      });
      expect(r.status).toBe(401);
    });

    it("buildDashboardHtml produces non-empty string", () => {
      const html = buildDashboardHtml();
      expect(html.length).toBeGreaterThan(10000);
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).toContain("function esc(s)"); // XSS defense helper
      expect(html).toContain("renderDonut"); // component injected
      expect(html).toContain("renderGraph"); // graph module injected
    });
  });

  describe("error handling", () => {
    it("returns 404 for unknown routes", async () => {
      const r = await fetch(`http://127.0.0.1:${port}/totally-bogus-route`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(r.status).toBe(404);
    });

    it("returns 400 for /query without q parameter", async () => {
      const r = await fetch(`http://127.0.0.1:${port}/query`, {
        headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(r.status).toBe(400);
    });
  });
});
