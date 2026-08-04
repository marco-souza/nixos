/**
 * Unit tests for tasks-lib.ts
 * Tests DAG operations, topological sort, wave computation, critical path analysis.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  loadTasks,
  findTasksJson,
  buildAdjacency,
  buildReverseAdjacency,
  validateDependencies,
  detectCycles,
  topologicalSort,
  computeWaves,
  criticalPath,
  getTaskById,
  getTasksByPhase,
  getReadyTasks,
  getBlockedTasks,
  scanTaskStatus,
  computeStats,
  resolveTasksDir,
  readDoneMarkers,
  TaskError,
  type Task,
  type TasksData,
} from "../lib/tasks-lib.ts";

// ── Test Fixtures ───────────────────────────────────────────────────

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

const SIMPLE_TASKS: TasksData = {
  $schema: "test",
  metadata: { totalTasks: 4, totalEstimatedHours: 14 },
  phases: {
    design: { label: "Design", description: "Design", tasks: ["T001", "T002"] },
    implementation: { label: "Impl", description: "Impl", tasks: ["T003", "T004"] },
  },
  tasks: [
    { id: "T001", title: "Schema", description: "Design schema", phase: "design", priority: "critical", estimatedHours: 2, dependencies: [], agent: "default", moeExperts: [], acceptanceCriteria: [] },
    { id: "T002", title: "API", description: "Design API", phase: "design", priority: "high", estimatedHours: 3, dependencies: ["T001"], agent: "default", moeExperts: [], acceptanceCriteria: [] },
    { id: "T003", title: "Impl Schema", description: "Implement schema", phase: "implementation", priority: "high", estimatedHours: 4, dependencies: ["T001"], agent: "default", moeExperts: [], acceptanceCriteria: [] },
    { id: "T004", title: "Impl API", description: "Implement API", phase: "implementation", priority: "medium", estimatedHours: 5, dependencies: ["T002", "T003"], agent: "default", moeExperts: [], acceptanceCriteria: [] },
  ],
  agents: {
    default: { role: "Dev", tasks: ["T001", "T002", "T003", "T004"] },
  },
};

const PARALLEL_TASKS: TasksData = {
  $schema: "test",
  metadata: { totalTasks: 5, totalEstimatedHours: 15 },
  phases: {
    w1: { label: "W1", description: "W1", tasks: ["T001", "T002"] },
    w2: { label: "W2", description: "W2", tasks: ["T003", "T004"] },
    w3: { label: "W3", description: "W3", tasks: ["T005"] },
  },
  tasks: [
    { id: "T001", title: "1", description: "", phase: "w1", priority: "high", estimatedHours: 2, dependencies: [], agent: "default", moeExperts: [], acceptanceCriteria: [] },
    { id: "T002", title: "2", description: "", phase: "w1", priority: "high", estimatedHours: 3, dependencies: [], agent: "default", moeExperts: [], acceptanceCriteria: [] },
    { id: "T003", title: "3", description: "", phase: "w2", priority: "medium", estimatedHours: 4, dependencies: ["T001"], agent: "default", moeExperts: [], acceptanceCriteria: [] },
    { id: "T004", title: "4", description: "", phase: "w2", priority: "medium", estimatedHours: 3, dependencies: ["T002"], agent: "default", moeExperts: [], acceptanceCriteria: [] },
    { id: "T005", title: "5", description: "", phase: "w3", priority: "low", estimatedHours: 3, dependencies: ["T003", "T004"], agent: "default", moeExperts: [], acceptanceCriteria: [] },
  ],
  agents: {
    default: { role: "Dev", tasks: ["T001", "T002", "T003", "T004", "T005"] },
  },
};

const CIRCULAR_TASKS: TasksData = {
  $schema: "test",
  metadata: { totalTasks: 3, totalEstimatedHours: 9 },
  phases: { core: { label: "Core", description: "Core", tasks: ["T001", "T002", "T003"] } },
  tasks: [
    { id: "T001", title: "A", description: "", phase: "core", priority: "high", estimatedHours: 3, dependencies: ["T003"], agent: "default", moeExperts: [], acceptanceCriteria: [] },
    { id: "T002", title: "B", description: "", phase: "core", priority: "high", estimatedHours: 3, dependencies: ["T001"], agent: "default", moeExperts: [], acceptanceCriteria: [] },
    { id: "T003", title: "C", description: "", phase: "core", priority: "high", estimatedHours: 3, dependencies: ["T002"], agent: "default", moeExperts: [], acceptanceCriteria: [] },
  ],
  agents: { default: { role: "Dev", tasks: ["T001", "T002", "T003"] } },
};

const EMPTY_TASKS: TasksData = {
  $schema: "test",
  metadata: { totalTasks: 0, totalEstimatedHours: 0 },
  phases: {},
  tasks: [],
  agents: {},
};

const MISSING_DEPS_TASKS: TasksData = {
  $schema: "test",
  metadata: { totalTasks: 2, totalEstimatedHours: 6 },
  phases: { core: { label: "Core", description: "Core", tasks: ["T001", "T002"] } },
  tasks: [
    { id: "T001", title: "A", description: "", phase: "core", priority: "high", estimatedHours: 3, dependencies: ["T999"], agent: "default", moeExperts: [], acceptanceCriteria: [] },
    { id: "T002", title: "B", description: "", phase: "core", priority: "medium", estimatedHours: 3, dependencies: [], agent: "default", moeExperts: [], acceptanceCriteria: [] },
  ],
  agents: { default: { role: "Dev", tasks: ["T001", "T002"] } },
};

// ── Load Tasks ──────────────────────────────────────────────────────

describe("loadTasks", () => {
  test("loads a valid tasks.json file", async () => {
    const data = await loadTasks(join(FIXTURES_DIR, "tasks-simple.json"));
    expect(data.tasks).toHaveLength(4);
    expect(data.tasks[0].id).toBe("T001");
  });

  test("throws TaskError for non-existent file", async () => {
    await expect(loadTasks("/nonexistent/tasks.json")).rejects.toThrow(TaskError);
  });

  test("throws TaskError for invalid JSON", async () => {
    const tmpDir = join(import.meta.dir, "tmp-invalid");
    mkdirSync(tmpDir, { recursive: true });
    const tmpFile = join(tmpDir, "bad.json");
    writeFileSync(tmpFile, "{ invalid json }}}", "utf-8");
    try {
      await expect(loadTasks(tmpFile)).rejects.toThrow(TaskError);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── findTasksJson ───────────────────────────────────────────────────

describe("findTasksJson", () => {
  test("finds tasks.json in given directory", () => {
    // Create a temp dir with a tasks.json
    const tmpDir = join(import.meta.dir, "tmp-find");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(tmpDir, "tasks.json"), JSON.stringify({ tasks: [] }), "utf-8");
    try {
      const found = findTasksJson(tmpDir);
      expect(found).toBe(join(tmpDir, "tasks.json"));
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("throws TaskError when not found", () => {
    expect(() => findTasksJson("/tmp")).toThrow(TaskError);
  });
});

// ── Build Adjacency ─────────────────────────────────────────────────

describe("buildAdjacency", () => {
  test("builds adjacency map for simple DAG", () => {
    const adj = buildAdjacency(SIMPLE_TASKS.tasks);
    expect(adj.get("T001")).toEqual([]);
    expect(adj.get("T002")).toEqual(["T001"]);
    expect(adj.get("T003")).toEqual(["T001"]);
    expect(adj.get("T004")).toEqual(["T002", "T003"]);
  });

  test("handles tasks with no dependencies", () => {
    const adj = buildAdjacency(EMPTY_TASKS.tasks);
    expect(adj.size).toBe(0);
  });
});

// ── Build Reverse Adjacency ─────────────────────────────────────────

describe("buildReverseAdjacency", () => {
  test("builds reverse adjacency correctly", () => {
    const reverse = buildReverseAdjacency(SIMPLE_TASKS.tasks);
    expect(reverse.get("T001")).toEqual(["T002", "T003"]);
    expect(reverse.get("T002")).toEqual(["T004"]);
    expect(reverse.get("T003")).toEqual(["T004"]);
    expect(reverse.get("T004")).toEqual([]);
  });
});

// ── Validate Dependencies ──────────────────────────────────────────

describe("validateDependencies", () => {
  test("returns empty for valid dependencies", () => {
    const errors = validateDependencies(SIMPLE_TASKS.tasks);
    expect(errors).toEqual([]);
  });

  test("detects missing dependency references", () => {
    const errors = validateDependencies(MISSING_DEPS_TASKS.tasks);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("T999");
  });

  test("returns empty for tasks with no dependencies", () => {
    const errors = validateDependencies(EMPTY_TASKS.tasks);
    expect(errors).toEqual([]);
  });
});

// ── Detect Cycles ──────────────────────────────────────────────────

describe("detectCycles", () => {
  test("detects circular dependencies", () => {
    const cycles = detectCycles(CIRCULAR_TASKS.tasks);
    expect(cycles.length).toBeGreaterThan(0);
  });

  test("returns empty for valid DAG", () => {
    const cycles = detectCycles(SIMPLE_TASKS.tasks);
    expect(cycles).toEqual([]);
  });

  test("returns empty for empty tasks", () => {
    const cycles = detectCycles(EMPTY_TASKS.tasks);
    expect(cycles).toEqual([]);
  });
});

// ── Topological Sort ───────────────────────────────────────────────

describe("topologicalSort", () => {
  test("returns valid topological order", () => {
    const order = topologicalSort(SIMPLE_TASKS.tasks);
    expect(order).toHaveLength(4);

    // T001 must come before T002, T003, T004
    const t001Idx = order.indexOf("T001");
    expect(order.indexOf("T002")).toBeGreaterThan(t001Idx);
    expect(order.indexOf("T003")).toBeGreaterThan(t001Idx);
    expect(order.indexOf("T004")).toBeGreaterThan(t001Idx);
  });

  test("preserves dependencies in parallel DAG", () => {
    const order = topologicalSort(PARALLEL_TASKS.tasks);
    expect(order).toHaveLength(5);

    // T001 before T003; T002 before T004; T003, T004 before T005
    const idx = (id: string) => order.indexOf(id);
    expect(idx("T001")).toBeLessThan(idx("T003"));
    expect(idx("T002")).toBeLessThan(idx("T004"));
    expect(idx("T003")).toBeLessThan(idx("T005"));
    expect(idx("T004")).toBeLessThan(idx("T005"));
  });

  test("throws TaskError on circular dependencies", () => {
    expect(() => topologicalSort(CIRCULAR_TASKS.tasks)).toThrow(TaskError);
  });

  test("handles empty tasks array", () => {
    const order = topologicalSort(EMPTY_TASKS.tasks);
    expect(order).toEqual([]);
  });
});

// ── Compute Waves ──────────────────────────────────────────────────

describe("computeWaves", () => {
  test("computes correct waves for simple DAG", () => {
    const waves = computeWaves(SIMPLE_TASKS.tasks);
    expect(waves.length).toBe(3);
    // Wave 1: T001 (no deps)
    expect(waves[0]).toEqual(["T001"]);
    // Wave 2: T002, T003 (depend on T001)
    expect(waves[1]).toContain("T002");
    expect(waves[1]).toContain("T003");
    // Wave 3: T004 (depends on T002, T003)
    expect(waves[2]).toEqual(["T004"]);
  });

  test("computes correct waves for parallel DAG", () => {
    const waves = computeWaves(PARALLEL_TASKS.tasks);
    expect(waves.length).toBe(3);
    // Wave 1: T001, T002 (independent, sorted)
    expect(waves[0]).toEqual(["T001", "T002"]);
    // Wave 2: T003, T004 (each depends on one from wave 1)
    expect(waves[1]).toContain("T003");
    expect(waves[1]).toContain("T004");
    // Wave 3: T005 (depends on T003, T004)
    expect(waves[2]).toEqual(["T005"]);
  });

  test("throws TaskError for circular dependencies", () => {
    expect(() => computeWaves(CIRCULAR_TASKS.tasks)).toThrow(TaskError);
  });

  test("returns empty array for empty tasks", () => {
    const waves = computeWaves(EMPTY_TASKS.tasks);
    expect(waves).toEqual([]);
  });

  test("all tasks appear exactly once across waves", () => {
    const waves = computeWaves(PARALLEL_TASKS.tasks);
    const allIds = waves.flat();
    const uniqueIds = new Set(allIds);
    expect(uniqueIds.size).toBe(PARALLEL_TASKS.tasks.length);
    expect(allIds.length).toBe(uniqueIds.size);
  });
});

// ── Critical Path ──────────────────────────────────────────────────

describe("criticalPath", () => {
  test("finds critical path for simple DAG", () => {
    const cp = criticalPath(SIMPLE_TASKS.tasks);
    // Critical path: T001(2) → T002(3) or T003(4) → T004(5)
    // Longest: T001(2) → T003(4) → T004(5) = 11h
    expect(cp.hours).toBe(11);
    expect(cp.path).toContain("T001");
    expect(cp.path).toContain("T004");
  });

  test("finds critical path for parallel DAG", () => {
    const cp = criticalPath(PARALLEL_TASKS.tasks);
    // T002(3) → T004(3) → T005(3) = 9h
    // T001(2) → T003(4) → T005(3) = 9h
    expect(cp.hours).toBe(9);
    expect(cp.path).toContain("T005");
  });

  test("returns 0 hours for empty tasks", () => {
    const cp = criticalPath(EMPTY_TASKS.tasks);
    expect(cp.hours).toBe(0);
    expect(cp.path).toEqual([]);
  });

  test("single task returns itself", () => {
    const singleTask: Task[] = [
      { id: "T001", title: "Solo", description: "", phase: "p", priority: "high", estimatedHours: 5, dependencies: [], agent: "default", moeExperts: [], acceptanceCriteria: [] },
    ];
    const cp = criticalPath(singleTask);
    expect(cp.hours).toBe(5);
    expect(cp.path).toEqual(["T001"]);
  });
});

// ── Task Query Helpers ─────────────────────────────────────────────

describe("getTaskById", () => {
  test("finds task by ID", () => {
    const task = getTaskById(SIMPLE_TASKS.tasks, "T002");
    expect(task).toBeDefined();
    expect(task!.title).toBe("API");
  });

  test("returns undefined for non-existent ID", () => {
    const task = getTaskById(SIMPLE_TASKS.tasks, "T999");
    expect(task).toBeUndefined();
  });
});

describe("getTasksByPhase", () => {
  test("returns tasks in specified phase", () => {
    const designTasks = getTasksByPhase(SIMPLE_TASKS.tasks, "design");
    expect(designTasks).toHaveLength(2);
    expect(designTasks.map((t) => t.id)).toEqual(["T001", "T002"]);
  });

  test("returns empty for non-existent phase", () => {
    const tasks = getTasksByPhase(SIMPLE_TASKS.tasks, "nonexistent");
    expect(tasks).toEqual([]);
  });
});

describe("getReadyTasks", () => {
  test("returns tasks with all deps satisfied", () => {
    const ready = getReadyTasks(SIMPLE_TASKS.tasks, new Set(["T001"]));
    expect(ready).toContain("T002");
    expect(ready).toContain("T003");
    expect(ready).not.toContain("T004"); // needs T002 and T003
  });

  test("returns all tasks when no deps", () => {
    const ready = getReadyTasks(PARALLEL_TASKS.tasks, new Set());
    expect(ready).toEqual(["T001", "T002"]);
  });

  test("returns empty when all done", () => {
    const allIds = new Set(SIMPLE_TASKS.tasks.map((t) => t.id));
    const ready = getReadyTasks(SIMPLE_TASKS.tasks, allIds);
    expect(ready).toEqual([]);
  });
});

describe("getBlockedTasks", () => {
  test("returns blocked tasks with unmet deps", () => {
    const blocked = getBlockedTasks(SIMPLE_TASKS.tasks, new Set());
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked.find((b) => b.id === "T002")).toBeDefined();
  });

  test("returns empty when all deps satisfied", () => {
    const allIds = new Set(SIMPLE_TASKS.tasks.map((t) => t.id));
    const blocked = getBlockedTasks(SIMPLE_TASKS.tasks, allIds);
    expect(blocked).toEqual([]);
  });
});

// ── Scan Task Status ───────────────────────────────────────────────

describe("scanTaskStatus", () => {
  const tmpDir = join(import.meta.dir, "tmp-status");

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("detects done tasks from .done markers", () => {
    writeFileSync(join(tmpDir, "T001.done"), "done", "utf-8");
    const status = scanTaskStatus(SIMPLE_TASKS.tasks, tmpDir);
    expect(status.get("T001")).toBe("done");
  });

  test("detects running tasks from .out markers", () => {
    writeFileSync(join(tmpDir, "T002.out"), "output", "utf-8");
    const status = scanTaskStatus(SIMPLE_TASKS.tasks, tmpDir);
    expect(status.get("T002")).toBe("running");
  });

  test("marks pending tasks (no deps)", () => {
    const status = scanTaskStatus(SIMPLE_TASKS.tasks, tmpDir);
    expect(status.get("T001")).toBe("pending");
  });

  test("marks blocked tasks (deps not done)", () => {
    writeFileSync(join(tmpDir, "T001.done"), "done", "utf-8");
    // T002 depends on T001 — should be pending since T001 is done
    const status = scanTaskStatus(SIMPLE_TASKS.tasks, tmpDir);
    expect(status.get("T002")).toBe("pending");
  });

  test("marks tasks as pending when deps are done", () => {
    writeFileSync(join(tmpDir, "T001.done"), "done", "utf-8");
    writeFileSync(join(tmpDir, "T002.done"), "done", "utf-8");
    writeFileSync(join(tmpDir, "T003.done"), "done", "utf-8");
    const status = scanTaskStatus(SIMPLE_TASKS.tasks, tmpDir);
    // T004 depends on T002 and T003 — both done, so pending
    expect(status.get("T004")).toBe("pending");
  });
});

// ── Compute Stats ──────────────────────────────────────────────────

describe("computeStats", () => {
  test("computes correct stats", () => {
    const stats = computeStats(SIMPLE_TASKS);
    expect(stats.totalTasks).toBe(4);
    expect(stats.totalHours).toBe(14);
  });

  test("computes phase stats", () => {
    const stats = computeStats(SIMPLE_TASKS);
    expect(stats.phases.design.count).toBe(2);
    expect(stats.phases.design.hours).toBe(5);
    expect(stats.phases.implementation.count).toBe(2);
    expect(stats.phases.implementation.hours).toBe(9);
  });

  test("computes agent stats", () => {
    const stats = computeStats(SIMPLE_TASKS);
    expect(stats.agents.default.count).toBe(4);
    expect(stats.agents.default.hours).toBe(14);
  });

  test("computes critical path in stats", () => {
    const stats = computeStats(SIMPLE_TASKS);
    expect(stats.criticalPath.hours).toBe(11);
  });

  test("handles empty data", () => {
    const stats = computeStats(EMPTY_TASKS);
    expect(stats.totalTasks).toBe(0);
    expect(stats.totalHours).toBe(0);
  });
});

// ── Resolve Tasks Dir ──────────────────────────────────────────────

describe("resolveTasksDir", () => {
  test("resolves with project dir", () => {
    const dir = resolveTasksDir("/project");
    expect(dir).toBe("/project/tasks");
  });

  test("resolves relative to cwd", () => {
    const dir = resolveTasksDir();
    expect(dir).toContain("tasks");
  });
});

// ── Read Done Markers ──────────────────────────────────────────────

describe("readDoneMarkers", () => {
  const tmpDir = join(import.meta.dir, "tmp-markers");

  beforeEach(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("reads .done markers", () => {
    writeFileSync(join(tmpDir, "T001.done"), "done", "utf-8");
    writeFileSync(join(tmpDir, "T002.done"), "done", "utf-8");
    const done = readDoneMarkers(tmpDir);
    expect(done.has("T001")).toBe(true);
    expect(done.has("T002")).toBe(true);
    expect(done.has("T003")).toBe(false);
  });

  test("returns empty set for non-existent dir", () => {
    const done = readDoneMarkers("/nonexistent");
    expect(done.size).toBe(0);
  });

  test("ignores non-.done files", () => {
    writeFileSync(join(tmpDir, "T001.done"), "done", "utf-8");
    writeFileSync(join(tmpDir, "T002.out"), "output", "utf-8");
    writeFileSync(join(tmpDir, "T003-prompt"), "prompt", "utf-8");
    const done = readDoneMarkers(tmpDir);
    expect(done.size).toBe(1);
    expect(done.has("T001")).toBe(true);
  });
});
