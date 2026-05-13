import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphStore } from "../src/graph/store.js";
import { queryGraph, shortestPath } from "../src/graph/query.js";
import type { GraphEdge, GraphNode } from "../src/graph/schema.js";

function makeNode(id: string, label: string, overrides?: Partial<GraphNode>): GraphNode {
  return {
    id,
    label,
    kind: "function",
    sourceFile: "test.ts",
    sourceLocation: "L1",
    confidence: "EXTRACTED",
    confidenceScore: 1,
    lastVerified: Date.now(),
    queryCount: 0,
    metadata: {},
    ...overrides,
  };
}

function makeEdge(source: string, target: string, overrides?: Partial<GraphEdge>): GraphEdge {
  return {
    source,
    target,
    relation: "calls",
    confidence: "EXTRACTED",
    confidenceScore: 1,
    sourceFile: "test.ts",
    sourceLocation: "L1",
    lastVerified: Date.now(),
    metadata: {},
    ...overrides,
  };
}

describe("graph query counts", () => {
  let tmpDir: string;
  let store: GraphStore;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "engram-query-count-"));
    store = await GraphStore.open(join(tmpDir, "graph.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("increments queryCount for all nodes surfaced by queryGraph", () => {
    store.upsertNode(makeNode("alpha_fn", "alpha()"));
    store.upsertNode(makeNode("beta_fn", "beta()"));
    store.upsertNode(makeNode("gamma_fn", "gamma()"));
    store.upsertEdge(makeEdge("alpha_fn", "beta_fn"));
    store.upsertEdge(makeEdge("beta_fn", "gamma_fn"));

    const first = queryGraph(store, "alpha", { depth: 1, tokenBudget: 200 });
    expect(first.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(["alpha_fn", "beta_fn"]));
    expect(store.getNode("alpha_fn")?.queryCount).toBe(1);
    expect(store.getNode("beta_fn")?.queryCount).toBe(1);
    expect(store.getNode("gamma_fn")?.queryCount).toBe(0);

    const second = queryGraph(store, "alpha", { depth: 1, tokenBudget: 200 });
    expect(second.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(["alpha_fn", "beta_fn"]));
    expect(store.getNode("alpha_fn")?.queryCount).toBe(2);
    expect(store.getNode("beta_fn")?.queryCount).toBe(2);
    expect(store.getNode("gamma_fn")?.queryCount).toBe(0);
  });

  it("increments queryCount for nodes on shortest paths", () => {
    store.upsertNode(makeNode("alpha_fn", "alpha()"));
    store.upsertNode(makeNode("beta_fn", "beta()"));
    store.upsertNode(makeNode("gamma_fn", "gamma()"));
    store.upsertEdge(makeEdge("alpha_fn", "beta_fn"));
    store.upsertEdge(makeEdge("beta_fn", "gamma_fn"));

    const first = shortestPath(store, "alpha", "gamma");
    expect(first.nodes.map((n) => n.id)).toEqual(["alpha_fn", "beta_fn", "gamma_fn"]);
    expect(store.getNode("alpha_fn")?.queryCount).toBe(1);
    expect(store.getNode("beta_fn")?.queryCount).toBe(1);
    expect(store.getNode("gamma_fn")?.queryCount).toBe(1);

    const second = shortestPath(store, "alpha", "gamma");
    expect(second.nodes.map((n) => n.id)).toEqual(["alpha_fn", "beta_fn", "gamma_fn"]);
    expect(store.getNode("alpha_fn")?.queryCount).toBe(2);
    expect(store.getNode("beta_fn")?.queryCount).toBe(2);
    expect(store.getNode("gamma_fn")?.queryCount).toBe(2);
  });
});
