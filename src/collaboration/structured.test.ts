import { expect, test } from "vitest";
import * as Y from "yjs";
import { SharedBoard, LOCAL } from "./shared";
import {
  createDocument,
  createElement,
  DEFAULT_STYLE,
} from "../editor/model/types";
import type { SceneElement } from "../editor/model/types";
import {
  gridOf,
  insertTableRow,
  insertTableColumn,
  deleteTableAxis,
} from "../editor/model/data";

function peers() {
  const table: SceneElement = {
    ...createElement("table", 0, 0, DEFAULT_STYLE),
    id: "table",
    width: 420,
    height: 180,
    cells: [
      ["Название", "Цена"],
      ["abcdef", "10"],
      ["Второе", "20"],
    ],
  };
  table.grid = gridOf(table);
  const task: SceneElement = {
    ...createElement("task", 500, 0, DEFAULT_STYLE),
    id: "task",
    width: 320,
    height: 240,
    task: {
      status: "todo",
      description: "abcdef",
      tags: ["общий"],
      items: [
        { id: "one", text: "abcdef", done: false },
        { id: "two", text: "Второй", done: false },
      ],
    },
  };
  const a = new SharedBoard();
  a.seed({ ...createDocument(), elements: [table, task] });
  const b = new SharedBoard();
  b.apply(a.encode());
  return { a, b, base: a.snapshot() };
}
function sync(a: SharedBoard, b: SharedBoard) {
  const ua = a.encode(Y.encodeStateVector(b.doc)),
    ub = b.encode(Y.encodeStateVector(a.doc));
  a.apply(ub);
  b.apply(ua);
  expect(a.snapshot().elements).toEqual(b.snapshot().elements);
}
function patch(board: SharedBoard, f: (el: SceneElement) => SceneElement) {
  const before = board.snapshot();
  board.patch(before, { ...before, elements: before.elements.map(f) });
}
test("different cells and independent insertions merge by stable row/column identity", () => {
  const { a, b } = peers();
  patch(a, (el) => {
    if (el.id !== "table") return el;
    const next = structuredClone(insertTableRow(el, 1));
    next.cells![1][0] = "Строка Алисы";
    next.cells![2][0] = "Xabcdef";
    return next;
  });
  patch(b, (el) => {
    if (el.id !== "table") return el;
    const next = insertTableColumn(el, 1);
    next.cells![0][1] = "Новый столбец";
    next.cells![1][2] = "42";
    next.cells![1][0] = "abcdefY";
    return next;
  });
  sync(a, b);
  const table = a.snapshot().elements[0];
  expect(table.cells).toEqual([
    ["Название", "Новый столбец", "Цена"],
    ["Строка Алисы", "", ""],
    ["XabcdefY", "", "42"],
    ["Второе", "", "20"],
  ]);
  expect(table.grid!.rows).toHaveLength(4);
  expect(table.grid!.columns).toHaveLength(3);
  a.destroy();
  b.destroy();
});
test("concurrent row and column removals win over stale edits and never shift values into another record", () => {
  const { a, b } = peers();
  patch(a, (el) =>
    el.id === "table"
      ? deleteTableAxis(deleteTableAxis(el, "row", 1), "column", 1)
      : el,
  );
  patch(b, (el) => {
    if (el.id !== "table") return el;
    const cells = structuredClone(el.cells!);
    cells[1][0] = "удалено";
    cells[2][0] = "Остаётся";
    cells[2][1] = "999";
    return { ...el, cells };
  });
  sync(a, b);
  expect(a.snapshot().elements[0].cells).toEqual([["Название"], ["Остаётся"]]);
  a.destroy();
  b.destroy();
});
test("concurrent insertions at the same slot keep both records, including after move, replay and reload", () => {
  const { a, b } = peers();
  for (const [board, label] of [
    [a, "А"],
    [b, "Б"],
  ] as const)
    patch(board, (el) => {
      if (el.id !== "table") return el;
      const next = insertTableRow(el, 1);
      next.cells![1][0] = label;
      return next;
    });
  sync(a, b);
  for (const [board, first] of [
    [a, 1],
    [b, 2],
  ] as const)
    patch(board, (el) => {
      if (el.id !== "table") return el;
      const order = [
        0,
        first,
        ...el.grid!.rows.map((_, i) => i).filter((i) => i !== 0 && i !== first),
      ];
      return {
        ...el,
        cells: order.map((i) => el.cells![i]),
        grid: { ...el.grid!, rows: order.map((i) => el.grid!.rows[i]) },
      };
    });
  sync(a, b);
  b.apply(a.encode());
  a.apply(b.encode());
  sync(a, b);
  const clone = new SharedBoard();
  clone.apply(a.encode());
  const cells = clone.snapshot().elements[0].cells!;
  expect(cells).toHaveLength(5);
  expect(cells.flat()).toContain("А");
  expect(cells.flat()).toContain("Б");
  expect(new Set(clone.snapshot().elements[0].grid!.rows).size).toBe(5);
  a.destroy();
  b.destroy();
  clone.destroy();
});
test("deleting the last different axes concurrently leaves an editable empty placeholder", () => {
  const { a, b } = peers();
  // Reduce to two rows and two columns, then delete different remaining axes offline.
  patch(a, (el) => (el.id === "table" ? deleteTableAxis(el, "row", 2) : el));
  sync(a, b);
  patch(a, (el) =>
    el.id === "table"
      ? deleteTableAxis(deleteTableAxis(el, "row", 0), "column", 0)
      : el,
  );
  patch(b, (el) =>
    el.id === "table"
      ? deleteTableAxis(deleteTableAxis(el, "row", 1), "column", 1)
      : el,
  );
  sync(a, b);
  expect(a.snapshot().elements[0].cells).toEqual([[""]]);
  patch(a, (el) =>
    el.id === "table" ? { ...el, cells: [["Новые данные"]] } : el,
  );
  sync(a, b);
  expect(b.snapshot().elements[0].cells).toEqual([["Новые данные"]]);
  a.destroy();
  b.destroy();
});
test("task fields, checklist text/check state, insertions and tag sets merge independently; own undo preserves remote edits", () => {
  const { a, b } = peers();
  const undo = new Y.UndoManager([a.meta, a.elements], {
    trackedOrigins: new Set([LOCAL]),
    captureTimeout: 0,
  });
  patch(a, (el) =>
    el.task
      ? {
          ...el,
          task: {
            ...el.task,
            status: "doing",
            description: "Xabcdef",
            tags: [...el.task.tags!, "А"],
            items: el.task.items.map((i) =>
              i.id === "one" ? { ...i, text: "Xabcdef" } : i,
            ),
          },
        }
      : el,
  );
  patch(b, (el) =>
    el.task
      ? {
          ...el,
          task: {
            ...el.task,
            due: "2026-11-10",
            description: "abcdefY",
            tags: [...el.task.tags!, "Б"],
            items: [
              ...el.task.items.map((i) =>
                i.id === "one" ? { ...i, text: "abcdefY", done: true } : i,
              ),
              { id: "three", text: "Новый", done: false },
            ],
          },
        }
      : el,
  );
  sync(a, b);
  expect(a.snapshot().elements[1].task).toMatchObject({
    status: "doing",
    due: "2026-11-10",
    description: "XabcdefY",
    items: [
      { id: "one", text: "XabcdefY", done: true },
      { id: "two" },
      { id: "three" },
    ],
  });
  expect(new Set(a.snapshot().elements[1].task!.tags)).toEqual(
    new Set(["общий", "А", "Б"]),
  );
  undo.undo();
  sync(a, b);
  expect(a.snapshot().elements[1].task).toMatchObject({
    status: "todo",
    due: "2026-11-10",
    description: "abcdefY",
    items: [
      { id: "one", text: "abcdefY", done: true },
      { id: "two" },
      { id: "three" },
    ],
  });
  expect(new Set(a.snapshot().elements[1].task!.tags)).toEqual(
    new Set(["общий", "Б"]),
  );
  undo.destroy();
  a.destroy();
  b.destroy();
});
test("table undo restores only the author's cell operation while keeping remote columns and values", () => {
  const { a, b } = peers();
  const undo = new Y.UndoManager([a.meta, a.elements], {
    trackedOrigins: new Set([LOCAL]),
    captureTimeout: 0,
  });
  patch(a, (el) =>
    el.id === "table"
      ? {
          ...el,
          cells: el.cells!.map((row, r) =>
            row.map((v, c) => (r === 1 && c === 0 ? "Изменено" : v)),
          ),
        }
      : el,
  );
  patch(b, (el) => {
    if (el.id !== "table") return el;
    const next = insertTableColumn(el, 2);
    next.cells![1][2] = "Чужое";
    return next;
  });
  sync(a, b);
  undo.undo();
  sync(a, b);
  expect(b.snapshot().elements[0].cells![1]).toEqual(["abcdef", "10", "Чужое"]);
  undo.redo();
  sync(a, b);
  expect(b.snapshot().elements[0].cells![1]).toEqual([
    "Изменено",
    "10",
    "Чужое",
  ]);
  undo.destroy();
  a.destroy();
  b.destroy();
});
test("deleted checklist entries do not resurrect on stale edits; a new entry remains", () => {
  const { a, b } = peers();
  patch(a, (el) =>
    el.task
      ? {
          ...el,
          task: {
            ...el.task,
            items: el.task.items.filter((i) => i.id !== "one"),
          },
        }
      : el,
  );
  patch(b, (el) =>
    el.task
      ? {
          ...el,
          task: {
            ...el.task,
            items: [
              ...el.task.items.map((i) => ({ ...i, text: "Другое" })),
              { id: "new", text: "Новый", done: false },
            ],
          },
        }
      : el,
  );
  sync(a, b);
  expect(a.snapshot().elements[1].task!.items.map((i) => i.id)).toEqual([
    "two",
    "new",
  ]);
  a.destroy();
  b.destroy();
});
test("legacy atomic task/table states migrate on first edit without discarding untouched data", () => {
  const { a } = peers(),
    legacy = new Y.Doc();
  const source = a.snapshot();
  const map = legacy.getMap("board");
  for (const key of ["id", "title", "createdAt"] as const)
    map.set(key, source[key]);
  const elements = legacy.getMap("elements");
  source.elements.forEach((e, i) => {
    const target = new Y.Map();
    elements.set(e.id, target);
    for (const [k, v] of Object.entries(e)) if (k !== "grid") target.set(k, v);
    target.set("_order", i);
  });
  const b = new SharedBoard(legacy);
  patch(b, (el) =>
    el.task
      ? { ...el, task: { ...el.task, status: "doing" } }
      : {
          ...el,
          cells: el.cells!.map((r, i) => (i === 1 ? ["Обновлено", r[1]] : r)),
        },
  );
  expect(b.snapshot().elements[0].cells![2]).toEqual(["Второе", "20"]);
  expect(b.snapshot().elements[1].task!.items[0].text).toBe("abcdef");
  a.destroy();
  b.destroy();
});
test("mixed offline structural operations converge under replay across multiple deterministic sequences", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const { a, b } = peers();
    let state = seed;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    for (let step = 0; step < 12; step++) {
      const board = random() % 2 ? a : b,
        operation = random() % 5;
      patch(board, (el) => {
        if (el.id !== "table") return el;
        const next = structuredClone(el);
        if (operation === 0 && next.cells!.length < 15) {
          const added = insertTableRow(next, random() % next.cells!.length);
          added.cells![0][0] += "r";
          return added;
        }
        if (operation === 1 && next.cells!.length > 1)
          return deleteTableAxis(next, "row", random() % next.cells!.length);
        if (operation === 2 && next.cells![0].length < 10)
          return insertTableColumn(next, random() % next.cells![0].length);
        if (operation === 3 && next.cells![0].length > 1)
          return deleteTableAxis(
            next,
            "column",
            random() % next.cells![0].length,
          );
        next.cells![random() % next.cells!.length][
          random() % next.cells![0].length
        ] += "x";
        return next;
      });
      if (step % 3 === 2) sync(a, b);
    }
    sync(a, b);
    const copy = new SharedBoard();
    copy.apply(a.encode());
    copy.apply(b.encode());
    expect(copy.snapshot().elements).toEqual(a.snapshot().elements);
    a.destroy();
    b.destroy();
    copy.destroy();
  }
});
