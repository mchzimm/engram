import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { performance } from "node:perf_hooks";
import { buildGraphScript } from "../../src/server/ui-graph.js";

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const ctx = {
    scale() {},
    clearRect() {},
    save() {},
    restore() {},
    translate() {},
    beginPath() {},
    arc() {},
    rect() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    stroke() {},
    fill() {},
    setLineDash() {},
    fillText() {},
    measureText(text: string) {
      return { width: text.length * 6 };
    },
    get globalAlpha() {
      return 1;
    },
    set globalAlpha(_value: number) {},
    get lineWidth() {
      return 1;
    },
    set lineWidth(_value: number) {},
    get strokeStyle() {
      return "";
    },
    set strokeStyle(_value: string) {},
    get fillStyle() {
      return "";
    },
    set fillStyle(_value: string) {},
    get font() {
      return "";
    },
    set font(_value: string) {},
    get textAlign() {
      return "";
    },
    set textAlign(_value: string) {},
    get textBaseline() {
      return "";
    },
    set textBaseline(_value: string) {},
  };

  return {
    width: 0,
    height: 0,
    style: {},
    getContext() {
      return ctx;
    },
    getBoundingClientRect() {
      return { width, height, left: 0, top: 0 };
    },
    addEventListener() {},
  } as unknown as HTMLCanvasElement;
}

function createHarness() {
  const context: any = {
    window: null,
    document: {
      getElementById() {
        return { textContent: "" };
      },
    },
    console,
    Math,
    Date,
    performance,
    requestAnimationFrame: () => 0,
    setText: () => {},
    renderMemoryLegend: () => {},
    setTimeout: (fn: Function) => {
      fn();
      return 1;
    },
    clearTimeout: () => {},
  };
  context.window = context;
  context.self = context;
  context.globalThis = context;
  context.devicePixelRatio = 1;
  context.window.devicePixelRatio = 1;
  context.window.addEventListener = () => {};
  context.addEventListener = () => {};
  context.window.__engram_graph_stop = null;
  vm.createContext(context);
  vm.runInContext(buildGraphScript(), context);
  return context;
}

function makeGraph(projects: number, filesPerProject: number, godPerProject: number) {
  const nodes: Array<{ id: string; label: string; kind: string; metadata: Record<string, unknown> }> = [];
  const edges: Array<{ source: string; target: string; relation: string }> = [];
  for (let p = 0; p < projects; p++) {
    const root = `/tmp/perf-project-${p}`;
    for (let i = 0; i < filesPerProject; i++) {
      nodes.push({
        id: `f${p}-${i}`,
        label: `file-${p}-${i}`,
        kind: "file",
        metadata: { projectRoot: root, memoryScope: "project" },
      });
    }
    for (let i = 0; i < godPerProject; i++) {
      nodes.push({
        id: `g${p}-${i}`,
        label: `god-${p}-${i}`,
        kind: "function",
        metadata: { projectRoot: root, memoryScope: "project" },
      });
    }
    for (let i = 0; i < filesPerProject - 1; i++) {
      edges.push({ source: `f${p}-${i}`, target: `f${p}-${i + 1}`, relation: "contains" });
    }
    for (let i = 0; i < godPerProject; i++) {
      edges.push({ source: `g${p}-${i}`, target: `f${p}-${i % filesPerProject}`, relation: "depends_on" });
    }
  }
  return { nodes, edges };
}

describe("graph streaming performance", () => {
  it("keeps repeated prioritized streaming fast and exposes perf metrics", async () => {
    const context = createHarness();
    const canvas = makeCanvas(900, 700);
    const { nodes, edges } = makeGraph(4, 20, 5);
    const godNodes = nodes
      .filter((n) => n.id.startsWith("g"))
      .map((n) => ({ node: n, degree: 10 }));

    const run = async () => {
      const start = performance.now();
      await context.__engram_graph_renderGraphPriorityStream(canvas, nodes, godNodes, edges);
      const elapsed = performance.now() - start;
      return {
        elapsed,
        perf: { ...(context.window.__engram_graph_perfMetrics ?? {}) },
      };
    };

    const first = await run();
    const second = await run();

    expect(first.elapsed).toBeLessThan(500);
    expect(second.elapsed).toBeLessThan(500);
    expect(second.elapsed).toBeLessThan(first.elapsed * 1.5);

    expect(second.perf).toHaveProperty("avgStreamMs");
    expect(second.perf).toHaveProperty("streamSampleCount");
    expect(Number(second.perf.avgStreamMs)).toBeGreaterThan(0);
    expect(Number(second.perf.streamSampleCount)).toBeGreaterThanOrEqual(2);
    expect(Number(second.perf.lastStreamNodes)).toBe(nodes.length);
    expect(Number(second.perf.lastVisibleEdges)).toBe(edges.length);
    expect(Number(second.perf.lastBatchSize)).toBeGreaterThanOrEqual(1);

    const bounds = canvas.getBoundingClientRect();
    const layoutScale = Number(context.window.__engram_graph_layoutScale ?? 0);
    const layoutMode = String(context.window.__engram_graph_layoutMode ?? "");
    const layoutNodes = Array.isArray(context.window.__engram_graph_layoutNodes)
      ? context.window.__engram_graph_layoutNodes
      : [];
    expect(layoutScale).toBeGreaterThan(1);
    expect(layoutMode).toBe("settle-first");
    expect(layoutNodes.length).toBeGreaterThan(0);
    expect(layoutNodes.some((n: { x?: number; y?: number }) => {
      const x = Number(n.x);
      const y = Number(n.y);
      return x < 0 || y < 0 || x > bounds.width || y > bounds.height;
    })).toBe(true);
    const xs = layoutNodes.map((n: { x?: number }) => Number(n.x)).filter((n: number) => Number.isFinite(n));
    const ys = layoutNodes.map((n: { y?: number }) => Number(n.y)).filter((n: number) => Number.isFinite(n));
    const width = Math.max(...xs) - Math.min(...xs);
    const height = Math.max(...ys) - Math.min(...ys);
    expect(Math.max(width, height) / Math.max(1, Math.min(width, height))).toBeLessThan(1.25);
    expect(Number(context.window.__engram_graph_viewState?.zoom ?? 0)).toBeLessThan(1);
  });
});
