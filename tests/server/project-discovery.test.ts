import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { discoverProjectsWithMemories } from "../../src/server/project-discovery.js";

describe("discoverProjectsWithMemories", () => {
  it("finds workspace projects that have local memory artifacts", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "engram-workspace-discovery-"));

    const engramProject = join(workspaceRoot, "engram-project");
    mkdirSync(join(engramProject, ".engram"), { recursive: true });
    writeFileSync(join(engramProject, ".engram", "graph.db"), "graph-db");

    const obsidianProject = join(workspaceRoot, "notes-vault");
    mkdirSync(join(obsidianProject, ".obsidian"), { recursive: true });

    const nestedContainer = join(workspaceRoot, "worlds.ai.rust-worktrees");
    const worktreeProject = join(nestedContainer, "Malians");
    mkdirSync(join(worktreeProject, ".pi"), { recursive: true });
    writeFileSync(join(worktreeProject, ".pi", "settings.json"), "{}\n");

    const nestedNoise = join(engramProject, "docs", ".obsidian");
    mkdirSync(nestedNoise, { recursive: true });

    try {
      const projects = discoverProjectsWithMemories(workspaceRoot);
      const roots = projects.map((p) => p.root);

      expect(roots).toEqual(expect.arrayContaining([engramProject, obsidianProject, worktreeProject]));
      expect(roots).not.toContain(join(engramProject, "docs"));
      expect(projects.every((p) => p.lastModified > 0)).toBe(true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
