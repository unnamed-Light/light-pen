import { expect, test } from "vitest";
import { createElement, DEFAULT_STYLE } from "./types";
import type { SceneElement, TaskData } from "./types";
import {
  queryTasks,
  taskIssues,
  taskInterval,
  dayNumber,
  isoDay,
  calendarDays,
  taskCounts,
} from "./tasks";
const task = (
  id: string,
  data: Partial<TaskData> = {},
  extra: Partial<SceneElement> = {},
): SceneElement => ({
  ...createElement("task", 0, 0, DEFAULT_STYLE),
  id,
  text: id,
  width: 320,
  height: 240,
  ...extra,
  task: { status: "todo", items: [], ...data },
});
test("task queries and summaries use source records, tags and descriptions and respect hidden/archive filters", () => {
  const elements = [
    task("one", {
      description: "Проверка выпуска",
      tags: ["релиз"],
      estimate: 2.5,
      items: [{ id: "i", text: "Проверить", done: true }],
    }),
    task("two", { status: "done", due: "2026-11-05" }),
    task("old", { archived: true }),
    task("hidden", {}, { hidden: true }),
  ];
  expect(
    queryTasks(elements, { search: "проверка", tag: "релиз" }).map((e) => e.id),
  ).toEqual(["one"]);
  expect(queryTasks(elements).map((e) => e.id)).toEqual(["two", "one"]);
  expect(queryTasks(elements, { archived: true })).toHaveLength(3);
  expect(taskCounts(elements)).toEqual({
    byStatus: { todo: 1, doing: 0, done: 1 },
    total: 2,
    completedItems: 1,
    items: 1,
    estimate: 2.5,
  });
  expect(taskCounts(elements, true).total).toBe(3);
});
test("dependency diagnostics distinguish actual cycles, blocked descendants and missing prerequisites without rejecting edits", () => {
  const elements = [
    task("a", { dependencies: ["b"] }),
    task("b", { dependencies: ["a"] }),
    task("downstream", { dependencies: ["a", "missing"] }),
    task("complete", { status: "done" }),
    task("ready", { dependencies: ["complete"] }),
    task("dates", { start: "2026-11-10", due: "2026-11-03" }),
  ];
  const issues = taskIssues(elements);
  expect(issues.get("a")!.cyclic).toBe(true);
  expect(issues.get("b")!.cyclic).toBe(true);
  expect(issues.get("downstream")).toMatchObject({
    cyclic: false,
    blocked: ["a"],
    missing: ["missing"],
  });
  expect(issues.get("ready")!.blocked).toEqual([]);
  expect(issues.get("dates")!.invertedDates).toBe(true);
});
test("long dependency chains are analyzed iteratively without overflowing the call stack", () => {
  const elements = Array.from({ length: 20_000 }, (_, i) =>
    task("t" + i, { dependencies: i ? ["t" + (i - 1)] : [] }),
  );
  const issues = taskIssues(elements);
  expect(issues.size).toBe(20_000);
  expect(issues.get("t19999")).toMatchObject({
    cyclic: false,
    blocked: ["t19998"],
  });
});
test("calendar uses Monday weeks and UTC arithmetic across DST/leap days and displays dates at format boundaries", () => {
  const days = calendarDays("2026-11");
  expect(days).toHaveLength(42);
  expect(days[0]).toBe("2026-10-26");
  expect(days.at(-1)).toBe("2026-12-06");
  expect(isoDay(dayNumber("2024-02-28") + 1)).toBe("2024-02-29");
  expect(isoDay(dayNumber("2024-03-31") + 1)).toBe("2024-04-01");
  expect(calendarDays("9999-12").at(-1)).toMatch(/^\+010000/);
  expect(() => calendarDays("2026-99")).toThrow();
  expect(
    taskInterval({ status: "todo", items: [], due: "2026-11-03" }),
  ).toEqual({
    start: dayNumber("2026-11-03"),
    end: dayNumber("2026-11-03"),
    inverted: false,
  });
});
