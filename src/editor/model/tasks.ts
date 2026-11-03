import type { SceneElement, TaskData } from "./types";
export const PRIORITY_NAMES = {
  none: "Не задан",
  low: "Низкий",
  normal: "Обычный",
  high: "Высокий",
  urgent: "Срочный",
};
export interface TaskQuery {
  search?: string;
  status?: TaskData["status"];
  archived?: boolean;
  priority?: TaskData["priority"];
  tag?: string;
}
export function queryTasks(elements: SceneElement[], query: TaskQuery = {}) {
  const search = query.search?.trim().toLocaleLowerCase();
  return elements
    .filter(
      (e): e is SceneElement & { task: TaskData } =>
        e.kind === "task" && !!e.task && !e.hidden,
    )
    .filter(
      (e) =>
        (query.archived || !e.task.archived) &&
        (!query.status || e.task.status === query.status) &&
        (!query.priority || (e.task.priority ?? "none") === query.priority) &&
        (!query.tag || e.task.tags?.includes(query.tag)) &&
        (!search ||
          `${e.text ?? ""} ${e.task.description ?? ""} ${e.task.tags?.join(" ") ?? ""} ${e.task.items.map((i) => i.text).join(" ")}`
            .toLocaleLowerCase()
            .includes(search)),
    )
    .sort(
      (a, b) =>
        (a.task.due ?? "9999-12-31").localeCompare(
          b.task.due ?? "9999-12-31",
        ) ||
        a.createdAt - b.createdAt ||
        a.id.localeCompare(b.id),
    );
}
export interface TaskIssue {
  id: string;
  missing: string[];
  blocked: string[];
  cyclic: boolean;
  invertedDates: boolean;
}
/** Iterative SCC avoids call-stack failures on long dependency chains. */
export function taskIssues(elements: SceneElement[]): Map<string, TaskIssue> {
  const tasks = new Map(
    elements.filter((e) => e.kind === "task" && e.task).map((e) => [e.id, e]),
  );
  const edges = new Map(
    [...tasks].map(([id, e]) => [
      id,
      (e.task!.dependencies ?? []).filter((id) => tasks.has(id)),
    ]),
  );
  const reverse = new Map([...tasks.keys()].map((id) => [id, [] as string[]]));
  for (const [id, list] of edges)
    for (const target of list) reverse.get(target)!.push(id);
  const visited = new Set<string>(),
    order: string[] = [];
  for (const id of tasks.keys()) {
    if (visited.has(id)) continue;
    visited.add(id);
    const stack: { id: string; index: number }[] = [{ id, index: 0 }];
    while (stack.length) {
      const top = stack.at(-1)!,
        list = edges.get(top.id)!;
      if (top.index >= list.length) {
        order.push(top.id);
        stack.pop();
        continue;
      }
      const next = list[top.index++];
      if (!visited.has(next)) {
        visited.add(next);
        stack.push({ id: next, index: 0 });
      }
    }
  }
  visited.clear();
  const cyclic = new Set<string>();
  for (const id of order.reverse()) {
    if (visited.has(id)) continue;
    const component: string[] = [],
      stack = [id];
    visited.add(id);
    while (stack.length) {
      const current = stack.pop()!;
      component.push(current);
      for (const next of reverse.get(current)!)
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
    }
    if (component.length > 1 || edges.get(id)?.includes(id))
      for (const node of component) cyclic.add(node);
  }
  return new Map(
    [...tasks].map(([id, e]) => {
      const dependencies = e.task!.dependencies ?? [];
      return [
        id,
        {
          id,
          missing: dependencies.filter((id) => !tasks.has(id)),
          blocked: dependencies.filter(
            (id) => tasks.has(id) && tasks.get(id)!.task!.status !== "done",
          ),
          cyclic: cyclic.has(id),
          invertedDates: !!(
            e.task!.start &&
            e.task!.due &&
            e.task!.start > e.task!.due
          ),
        },
      ];
    }),
  );
}
export const dayNumber = (date: string) =>
  Math.floor(Date.parse(date + "T00:00:00Z") / 86_400_000);
export const isoDay = (day: number) =>
  new Date(day * 86_400_000).toISOString().split("T")[0];
export function taskInterval(task: TaskData) {
  const start = task.start ?? task.due,
    end = task.due ?? task.start;
  if (!start || !end) return null;
  return {
    start: dayNumber(start),
    end: dayNumber(end),
    inverted: start > end,
  };
}
export function calendarDays(month: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 1)
    throw new Error("Недопустимый месяц календаря.");
  const first = new Date(month + "-01T00:00:00Z");
  const start =
    Math.floor(first.getTime() / 86_400_000) - ((first.getUTCDay() + 6) % 7);
  return Array.from({ length: 42 }, (_, i) => isoDay(start + i));
}
export function taskCounts(elements: SceneElement[], includeArchived = false) {
  const tasks = queryTasks(elements, { archived: includeArchived }),
    byStatus = { todo: 0, doing: 0, done: 0 };
  let completedItems = 0,
    items = 0,
    estimate = 0;
  for (const e of tasks) {
    byStatus[e.task.status]++;
    completedItems += e.task.items.filter((i) => i.done).length;
    items += e.task.items.length;
    estimate += e.task.estimate ?? 0;
  }
  return { byStatus, total: tasks.length, completedItems, items, estimate };
}
