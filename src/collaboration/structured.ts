import * as Y from "yjs";
import { gridOf } from "../editor/model/data";
import type {
  SceneElement,
  TaskData,
  TableColumn,
} from "../editor/model/types";

const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export function updateText(target: Y.Text, before: string, after: string) {
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  let tail = 0;
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before[before.length - tail - 1] === after[after.length - tail - 1]
  )
    tail++;
  const remove = before.length - start - tail;
  if (remove) target.delete(start, remove);
  const insert = after.slice(start, after.length - tail);
  if (insert) target.insert(start, insert);
}
function setText(
  map: Y.Map<unknown>,
  key: string,
  before: string,
  after: string,
) {
  const current = map.get(key);
  if (current instanceof Y.Text) updateText(current, before, after);
  else {
    const text = new Y.Text();
    map.set(key, text);
    text.insert(0, after);
  }
}
/** LCS leaves unchanged identities anchored, including concurrent remote insertions. */
function anchors(before: string[], after: string[]): Set<string> {
  const dp = Array.from(
    { length: before.length + 1 },
    () => new Uint16Array(after.length + 1),
  );
  for (let a = before.length - 1; a >= 0; a--)
    for (let b = after.length - 1; b >= 0; b--)
      dp[a][b] =
        before[a] === after[b]
          ? 1 + dp[a + 1][b + 1]
          : Math.max(dp[a + 1][b], dp[a][b + 1]);
  const result = new Set<string>();
  let a = 0,
    b = 0;
  while (a < before.length && b < after.length) {
    if (before[a] === after[b]) {
      result.add(before[a]);
      a++;
      b++;
    } else if (dp[a + 1][b] >= dp[a][b + 1]) a++;
    else b++;
  }
  return result;
}
function sequence(
  target: Y.Array<string>,
  before: string[],
  after: string[],
  available: Y.Map<unknown>,
) {
  const keep = anchors(before, after),
    old = new Set(before);
  const current = target.toArray();
  for (let i = current.length - 1; i >= 0; i--)
    if (old.has(current[i]) && !keep.has(current[i])) target.delete(i, 1);
  for (let i = 0; i < after.length; i++) {
    const id = after[i];
    if (!available.has(id)) continue;
    if (keep.has(id) && target.toArray().includes(id)) continue;
    const existing = target.toArray();
    // A local move removes all local duplicates. Concurrent moves may produce two
    // references; materialization picks the first, so every replica agrees.
    for (let j = existing.length - 1; j >= 0; j--)
      if (existing[j] === id) target.delete(j, 1);
    const next = after
      .slice(i + 1)
      .find((k) => keep.has(k) && available.has(k));
    const position = next ? target.toArray().indexOf(next) : -1;
    target.insert(position >= 0 ? position : target.length, [id]);
  }
}
function ordered(
  map: Y.Map<unknown>,
  order: Y.Array<string>,
  limit: number,
): string[] {
  if (map.size > limit || order.length > 100_000)
    throw new Error("Превышен размер общей структуры.");
  const result = [...new Set(order.toArray())].filter((id) => map.has(id));
  if (result.length !== map.size)
    throw new Error("Повреждён порядок общей структуры.");
  return result;
}
function requireMap(value: unknown): Y.Map<unknown> {
  if (!(value instanceof Y.Map)) throw new Error("Повреждено общее поле.");
  return value;
}
function requireOrder(value: unknown): Y.Array<string> {
  if (!(value instanceof Y.Array)) throw new Error("Повреждён общий порядок.");
  return value;
}
function container(target: Y.Map<unknown>, key: string) {
  const map = new Y.Map<unknown>();
  target.set(key, map);
  return map;
}
function orderField(target: Y.Map<unknown>, key: string) {
  const order = new Y.Array<string>();
  target.set(key, order);
  return order;
}
function fields(
  map: Y.Map<unknown>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  textKeys: Set<string>,
  skip = new Set<string>(),
) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (skip.has(key) || equal(before[key], after[key])) continue;
    if (after[key] === undefined) map.delete(key);
    else if (textKeys.has(key))
      setText(map, key, String(before[key] ?? ""), String(after[key]));
    else map.set(key, structuredClone(after[key]));
  }
}
export function seedGrid(target: Y.Map<unknown>, element: SceneElement) {
  const grid = container(target, "_grid");
  container(grid, "rows");
  container(grid, "columns");
  orderField(grid, "rowOrder");
  orderField(grid, "columnOrder");
  patchGrid(target, undefined, element);
}
export function patchGrid(
  target: Y.Map<unknown>,
  before: SceneElement | undefined,
  after: SceneElement,
) {
  const grid = requireMap(target.get("_grid")),
    rows = requireMap(grid.get("rows")),
    columns = requireMap(grid.get("columns"));
  const old = before ? gridOf(before) : { rows: [], columns: [] },
    next = gridOf(after);
  const rowOld = new Set(old.rows),
    rowNext = new Set(next.rows);
  const colOld = new Map(old.columns.map((c) => [c.id, c])),
    colNext = new Set(next.columns.map((c) => c.id));
  for (const id of old.rows) if (!rowNext.has(id)) rows.delete(id);
  for (const id of colOld.keys()) if (!colNext.has(id)) columns.delete(id);
  for (const column of next.columns) {
    let map = columns.get(column.id);
    const existed = !!map;
    if (
      !map &&
      (!colOld.has(column.id) ||
        (!columns.size && column.id === "empty-column"))
    )
      map = container(columns, column.id);
    if (map)
      fields(
        requireMap(map),
        existed ? { ...colOld.get(column.id) } : {},
        { ...column },
        new Set(),
      );
  }
  for (const [r, id] of next.rows.entries()) {
    let row = rows.get(id);
    if (!row && (!rowOld.has(id) || (!rows.size && id === "empty-row")))
      row = container(rows, id);
    if (!row) continue; // Deletion wins over stale cell edits.
    const map = requireMap(row),
      oldIndex = old.rows.indexOf(id);
    for (const [c, column] of next.columns.entries()) {
      if (!columns.has(column.id)) continue;
      const oldCol = old.columns.findIndex((v) => v.id === column.id);
      const previous = before?.cells?.[oldIndex]?.[oldCol] ?? "",
        value = after.cells![r][c];
      if (!map.has(column.id) || previous !== value)
        setText(map, column.id, previous, value);
    }
  }
  sequence(requireOrder(grid.get("rowOrder")), old.rows, next.rows, rows);
  sequence(
    requireOrder(grid.get("columnOrder")),
    old.columns.map((c) => c.id),
    next.columns.map((c) => c.id),
    columns,
  );
}
export function readGrid(target: Y.Map<unknown>) {
  if (!target.has("_grid")) {
    const cells = target.get("cells");
    if (!Array.isArray(cells)) throw new Error("Повреждена общая таблица.");
    const element = { cells } as SceneElement;
    return { cells: cells as string[][], grid: gridOf(element) };
  }
  const grid = requireMap(target.get("_grid")),
    rows = requireMap(grid.get("rows")),
    columns = requireMap(grid.get("columns"));
  const rowIds = ordered(rows, requireOrder(grid.get("rowOrder")), 1000);
  const columnIds = ordered(
    columns,
    requireOrder(grid.get("columnOrder")),
    200,
  );
  if (Math.max(1, rowIds.length) * Math.max(1, columnIds.length) > 50_000)
    throw new Error("В общей таблице слишком много ячеек.");
  // Two users can delete the last different axes concurrently. Keep an editable
  // empty placeholder without resurrecting either user's deleted record.
  const materialRows = rowIds.length ? rowIds : ["empty-row"];
  const materialColumns = columnIds.length
    ? columnIds.map((id) => requireMap(columns.get(id)).toJSON() as TableColumn)
    : [{ id: "empty-column", type: "text" as const }];
  const cells = materialRows.map((id) =>
    materialColumns.map((column) => {
      if (!rows.has(id) || !columns.has(column.id)) return "";
      const value = requireMap(rows.get(id)).get(column.id);
      if (value === undefined) return ""; // Concurrent insertion of a new row and column.
      if (!(value instanceof Y.Text))
        throw new Error("Повреждена общая ячейка.");
      return value.toString();
    }),
  );
  return { cells, grid: { rows: materialRows, columns: materialColumns } };
}
function patchSet(
  target: Y.Map<unknown>,
  key: string,
  before: string[],
  after: string[],
) {
  let set = target.get(key);
  if (!(set instanceof Y.Map)) set = container(target, key);
  const map = set as Y.Map<boolean>,
    next = new Set(after);
  for (const id of before) if (!next.has(id)) map.delete(id);
  for (const id of after) if (!before.includes(id)) map.set(id, true);
}
export function seedTask(target: Y.Map<unknown>, task: TaskData) {
  const map = container(target, "task");
  container(map, "_items");
  orderField(map, "_sequence");
  patchTask(target, undefined, task);
}
export function patchTask(
  target: Y.Map<unknown>,
  before: TaskData | undefined,
  after: TaskData,
) {
  const map = requireMap(target.get("task")),
    items = requireMap(map.get("_items"));
  const old = new Map((before?.items ?? []).map((i) => [i.id, i])),
    next = new Set(after.items.map((i) => i.id));
  fields(
    map,
    { ...before },
    { ...after },
    new Set(["description"]),
    new Set(["items", "tags", "dependencies"]),
  );
  for (const key of ["tags", "dependencies"] as const) {
    if (before?.[key] !== undefined || after[key] !== undefined)
      patchSet(map, key, before?.[key] ?? [], after[key] ?? []);
  }
  for (const id of old.keys()) if (!next.has(id)) items.delete(id);
  for (const item of after.items) {
    let current = items.get(item.id);
    if (!current && !old.has(item.id)) current = container(items, item.id);
    if (current)
      fields(
        requireMap(current),
        { ...old.get(item.id) },
        { ...item },
        new Set(["text"]),
      );
  }
  sequence(
    requireOrder(map.get("_sequence")),
    [...old.keys()],
    after.items.map((i) => i.id),
    items,
  );
}
export function readTask(target: Y.Map<unknown>): TaskData {
  if (!(target.get("task") instanceof Y.Map))
    return target.get("task") as TaskData;
  const map = requireMap(target.get("task")),
    items = requireMap(map.get("_items"));
  const { _items, _sequence, tags, dependencies, ...data } = map.toJSON();
  const result = {
    ...data,
    items: ordered(items, requireOrder(map.get("_sequence")), 1000).map(
      (id) => {
        const item = requireMap(items.get(id)).toJSON();
        if (item.id !== id) throw new Error("Повреждён пункт общей задачи.");
        return item;
      },
    ),
  } as TaskData;
  for (const key of ["tags", "dependencies"] as const)
    if (map.has(key)) result[key] = [...requireMap(map.get(key)).keys()].sort();
  return result;
}
