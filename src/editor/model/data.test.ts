import { expect, test } from "vitest";
import {
  createDocument,
  createElement,
  DEFAULT_STYLE,
  validateDocument,
  isDate,
} from "./types";
import type { SceneElement } from "./types";
import {
  gridOf,
  typedValue,
  columnSummary,
  queryRecords,
  insertTableRow,
  insertTableColumn,
  deleteTableAxis,
  replaceTableCells,
} from "./data";
import { parseCsv, parseTsv, toCsv } from "./tables";
function table(): SceneElement {
  const el = {
    ...createElement("table", 0, 0, DEFAULT_STYLE),
    width: 420,
    height: 200,
    cells: [
      ["Имя", "Цена"],
      ["Бета", "2"],
      ["Альфа", "10"],
      ["Гамма", "ошибка"],
      ["Дельта", ""],
    ],
  };
  return {
    ...el,
    grid: {
      ...gridOf(el),
      columns: [
        { id: "name", type: "text" },
        { id: "price", type: "number" },
      ],
    },
  };
}
test("typed query sorts numeric records, keeps stable identities, reports errors and counts/sums", () => {
  const el = table();
  expect(
    queryRecords(el, { column: "price", sort: "asc" }).map((r) => r.index),
  ).toEqual([1, 2, 3, 4]);
  expect(
    queryRecords(el, { column: "price", sort: "desc" }).at(-1)!.index,
  ).toBe(4);
  expect(queryRecords(el, { search: "альфа" }).map((r) => r.id)).toEqual([
    el.grid!.rows[2],
  ]);
  expect(queryRecords(el, { errorsOnly: true }).map((r) => r.index)).toEqual([
    3,
  ]);
  expect(columnSummary(el, 1)).toEqual({
    count: 3,
    errors: 1,
    sum: 12,
    average: 6,
  });
  expect(el.cells![1]).toEqual(["Бета", "2"]);
});
test("typed values accept decimal comma, leap dates, booleans and explicit choices; reject nonfinite/code URLs", () => {
  expect(typedValue("-2,5", { id: "x", type: "number" }).value).toBe(-2.5);
  for (const value of ["Infinity", "NaN", "0x12", "1e9999"])
    expect(typedValue(value, { id: "x", type: "number" }).error).toBeTruthy();
  expect(isDate("2024-02-29")).toBe(true);
  expect(isDate("2026-02-29")).toBe(false);
  expect(isDate("2026-04-31")).toBe(false);
  expect(typedValue("да", { id: "x", type: "checkbox" }).value).toBe(true);
  expect(
    typedValue("Другой", { id: "x", type: "select", options: ["Один"] }).error,
  ).toBeTruthy();
  expect(
    typedValue("javascript:alert(1)", { id: "x", type: "url" }).error,
  ).toBeTruthy();
  expect(
    typedValue("https://example.org", { id: "x", type: "url" }).error,
  ).toBeUndefined();
});
test("insert/delete/paste retain row and column identities rather than inferring them from positions", () => {
  const original = table(),
    inserted = insertTableColumn(insertTableRow(original, 1), 1);
  expect(inserted.grid!.rows[2]).toBe(original.grid!.rows[1]);
  expect(inserted.grid!.columns[2].id).toBe("price");
  const restored = deleteTableAxis(
    deleteTableAxis(inserted, "row", 1),
    "column",
    1,
  );
  expect(restored.grid).toEqual(original.grid);
  expect(restored.cells).toEqual(original.cells);
  const grown = replaceTableCells(original, [
    ...original.cells!,
    ["Новое", "3"],
  ]);
  expect(grown.grid!.rows.slice(0, -1)).toEqual(original.grid!.rows);
  expect(grown.grid!.rows.at(-1)).not.toBe(original.grid!.rows.at(-1));
});
test("CSV handles BOM, comma or semicolon, quotes/newlines and round-trips raw text; spreadsheet export neutralizes formulas", () => {
  const cells = [
    ["Имя", "Комментарий"],
    ["Ёж", 'Строка 1\nСтрока 2; , "текст"'],
  ];
  expect(parseCsv(toCsv(cells, false))).toEqual(cells);
  expect(parseCsv('\uFEFFИмя;Цена\r\nА;"1,5"\r\n')).toEqual([
    ["Имя", "Цена"],
    ["А", "1,5"],
  ]);
  expect(parseCsv(toCsv([["=SUM(A1)", "-2.5", "@run", "+cmd"]]))).toEqual([
    ["'=SUM(A1)", "-2.5", "'@run", "'+cmd"],
  ]);
  expect(() => parseCsv('"a"bad,b')).toThrow();
  expect(() => parseCsv('"a')).toThrow();
  expect(() => parseTsv("x\n".repeat(200_000))).toThrow(/строк/);
});
test("schema four validates stable identity shape and rejects broken grids/tasks without silently rewriting data", () => {
  const document = { ...createDocument(), elements: [table()] };
  expect(validateDocument(document)).toBe(document);
  for (const grid of [
    { rows: ["same", "same"], columns: [] },
    { ...table().grid, columns: [{ id: "x", type: "script" }] },
    { ...table().grid, rows: ["../bad"] },
  ])
    expect(() =>
      validateDocument({ ...document, elements: [{ ...table(), grid }] }),
    ).toThrow();
  expect(() => validateDocument({ ...document, schemaVersion: 3 })).toThrow();
  const task = {
    ...createElement("task", 0, 0, DEFAULT_STYLE),
    task: {
      status: "todo",
      start: "2026-11-04",
      due: "2026-11-03",
      description: "Текст",
      priority: "high",
      tags: ["План"],
      dependencies: ["another"],
      items: [],
    },
  };
  expect(() =>
    validateDocument({ ...createDocument(), elements: [task] }),
  ).not.toThrow(); // A merged date conflict is editable, not data loss.
  expect(() =>
    validateDocument({
      ...createDocument(),
      elements: [{ ...task, task: { ...task.task, due: "2026-02-30" } }],
    }),
  ).toThrow();
});
