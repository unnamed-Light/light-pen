import { describe, expect, it } from "vitest";
import { Editor } from "./editor";
import {
  createDocument,
  createElement,
  DEFAULT_STYLE,
  validateDocument,
} from "./model/types";
import type { SceneElement } from "./model/types";
import {
  bounds,
  hitTest,
  rotateElements,
  rotationCenter,
  sweepHitTest,
} from "./model/geometry";
import { anchor, copyElements, resolveBindings } from "./model/relations";
import { connectorPoints } from "./model/connectors";
import { parseTsv, pasteCells } from "./model/tables";
import { hexToHsv, hsvToHex } from "../app/ColorPalette";
const rect = (id: string, x = 0, y = 0, w = 100, h = 60): SceneElement => ({
  ...createElement("rectangle", x, y, DEFAULT_STYLE),
  id,
  width: w,
  height: h,
  fill: "#cfe9fd",
});
const seed = (els: SceneElement[]) => {
  const e = new Editor();
  e.document = { ...createDocument(), elements: els };
  e.camera = { x: 0, y: 0, zoom: 1 };
  e.tool = "select";
  e.snap = false;
  return e;
};
const sample = (x: number, y: number) => ({
  x,
  y,
  time: 10,
  pointerType: "mouse",
  pressure: 0.5,
});
it("rotated rectangular and ink hit tests and swept eraser use the visible geometry", () => {
  const el = { ...rect("r", 100, 100, 200, 20), rotation: 90 };
  expect(bounds(el).maxY - bounds(el).minY).toBeCloseTo(203);
  expect(hitTest(el, { x: 200, y: 180 }, 1)).toBe(true);
  expect(hitTest(el, { x: 115, y: 110 }, 1)).toBe(false);
  expect(sweepHitTest(el, { x: 150, y: 180 }, { x: 250, y: 180 }, 1)).toBe(
    true,
  );
  const ink = {
    ...createElement("stroke", 0, 0, DEFAULT_STYLE),
    points: [
      [0, 0, 0.5, 0],
      [100, 0, 0.5, 10],
    ] as [number, number, number, number][],
    rotation: 90,
  };
  expect(hitTest(ink, { x: 50, y: 30 }, 2)).toBe(true);
  expect(hitTest(ink, { x: 0, y: 0 }, 2)).toBe(false);
});
it("group rotation preserves distances and rotates each object around a common pivot", () => {
  const a = rect("a"),
    b = rect("b", 200, 0);
  const rotated = rotateElements([a, b], 90);
  const x = rotationCenter(rotated[0]),
    y = rotationCenter(rotated[1]);
  expect(x.x).toBeCloseTo(y.x);
  expect(Math.abs(x.y - y.y)).toBeCloseTo(200);
  expect(rotated.every((e) => e.rotation === 90)).toBe(true);
});
it("rotation drag snaps to fifteen degrees and cancellation leaves the document identical", () => {
  const e = seed([rect("a", 300, 300)]);
  e.selected.add("a");
  const original = e.elements;
  const b = e.selectionBounds!,
    center = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  e.pointerDown({ x: center.x, y: b.minY - 28 }, 1, sample(0, 0), 0, false);
  e.pointerMove({ x: center.x + 90, y: center.y }, 1, sample(0, 0), true);
  expect(e.previewElements[0].rotation).toBeCloseTo(90);
  e.cancelGesture();
  expect(e.elements).toBe(original);
  e.pointerDown({ x: center.x, y: b.minY - 28 }, 1, sample(0, 0), 0, false);
  e.pointerMove({ x: center.x + 90, y: center.y }, 1, sample(0, 0), true);
  e.pointerUp(1);
  expect(e.elements[0].rotation).toBeCloseTo(90);
  e.undo();
  expect(e.elements).toEqual(original);
});
it("continuous dimension and rotation previews commit one undo, never a revision per sample", () => {
  const e = seed([rect("a", 300, 300)]);
  e.selected.add("a");
  const original = e.elements;
  e.beginStyle();
  for (let i = 10; i <= 90; i += 10) e.rotateSelection(i, true);
  expect(e.document.revision).toBe(0);
  e.endStyle();
  expect(e.document.revision).toBe(1);
  e.undo();
  expect(e.elements).toEqual(original);
  e.beginStyle();
  e.resizeSelection(203, 123);
  e.resizeSelection(303, 183);
  e.endStyle();
  e.undo();
  expect(e.elements).toEqual(original);
});
it("hidden and locked objects resist pick, marquee, eraser, and select all", () => {
  const hidden = { ...rect("hidden", 100, 100), hidden: true },
    locked = { ...rect("locked", 300, 100), locked: true };
  const e = seed([hidden, locked]);
  expect(e.pick({ x: 150, y: 120 })).toBeNull();
  e.selectAll();
  expect(e.selected.size).toBe(0);
  e.setTool("eraser");
  e.pointerDown({ x: 150, y: 120 }, 1, sample(0, 0), 0, false);
  e.pointerMove({ x: 350, y: 120 }, 1, sample(0, 0), false);
  e.pointerUp(1);
  expect(e.elements).toHaveLength(2);
  e.setTool("select");
  e.pointerDown({ x: 50, y: 50 }, 1, sample(0, 0), 0, false);
  e.pointerMove({ x: 450, y: 200 }, 1, sample(0, 0), false);
  e.pointerUp(1);
  expect(e.selected.size).toBe(0);
});
it("layer order, visibility and names participate in undo without unlocking objects", () => {
  const e = seed([rect("a"), { ...rect("b"), locked: true }]);
  e.patchElement("b", { name: "Схема", hidden: true }, "Имя", true);
  expect(e.elements[1].locked).toBe(true);
  e.moveLayer("a", 1);
  expect(e.elements[1].id).toBe("a");
  e.undo();
  e.undo();
  expect(e.elements[1].hidden).toBeUndefined();
});
it("rotated anchors stay attached to their actual side", () => {
  const node = { ...rect("node", 100, 100), rotation: 90 };
  expect(anchor(node, "right").x).toBeCloseTo(150);
  expect(anchor(node, "right").y).toBeCloseTo(181.5);
  const arrow = {
    ...createElement("arrow", 0, 0, DEFAULT_STYLE),
    endX: 200,
    endY: 200,
    startBinding: { elementId: "node", side: "right" as const },
  };
  const resolved = resolveBindings([node, arrow])[1];
  expect(resolved.x).toBeCloseTo(150);
  expect(resolved.y).toBeCloseTo(181.5);
});
it("curved and orthogonal connectors are selectable and erasable along their visible paths", () => {
  for (const style of ["curve", "orthogonal"] as const) {
    const el = {
      ...createElement("arrow", 100, 100, DEFAULT_STYLE),
      width: 300,
      height: 180,
      endX: 300,
      endY: 180,
      connectorStyle: style,
    };
    const points = connectorPoints(el),
      p = points[Math.floor(points.length / 2)];
    expect(hitTest(el, { x: el.x + p.x, y: el.y + p.y }, 2)).toBe(true);
    expect(
      sweepHitTest(
        el,
        { x: el.x + p.x - 30, y: el.y + p.y - 30 },
        { x: el.x + p.x + 30, y: el.y + p.y + 30 },
        2,
      ),
    ).toBe(true);
  }
});
it("orthogonal route avoids an intervening obstacle and updates after the obstacle moves", () => {
  const arrow = {
    ...createElement("arrow", 0, 50, DEFAULT_STYLE),
    endX: 500,
    endY: 0,
    width: 500,
    height: 0,
    connectorStyle: "orthogonal" as const,
  };
  const obstacle = rect("obstacle", 200, 0, 100, 100),
    route = resolveBindings([obstacle, arrow])[1];
  expect(route.route!.some((p) => p.y < -50 || p.y > 50)).toBe(true);
  expect(
    route.route!.every(
      (p, i, arr) => i === 0 || p.x === arr[i - 1].x || p.y === arr[i - 1].y,
    ),
  ).toBe(true);
  const updated = resolveBindings([{ ...obstacle, y: 500 }, route])[1];
  expect(updated.route).not.toEqual(route.route);
});
it("templates remap groups, bindings and internal object links and insertion is one undo", () => {
  const a = {
      ...rect("a"),
      groupId: "group",
      link: { path: "", elementId: "b" },
    },
    b = { ...rect("b", 200), groupId: "group" };
  const copies = copyElements([a, b], 30, 40);
  expect(copies[0].groupId).toBe(copies[1].groupId);
  expect(copies[0].link!.elementId).toBe(copies[1].id);
  expect(copies[0].id).not.toBe("a");
  const e = seed([]);
  e.insertElements([a, b]);
  expect(e.elements).toHaveLength(2);
  expect(a.x).toBe(0);
  e.undo();
  expect(e.elements).toHaveLength(0);
});
it("task checkbox toggles exactly one item, respects rotation and has an exact undo", () => {
  const task = {
    ...createElement("task", 300, 200, { ...DEFAULT_STYLE, fontSize: 18 }),
    width: 320,
    height: 240,
    text: "Проверить",
    task: {
      status: "todo" as const,
      items: [
        { id: "one", text: "Первый", done: false },
        { id: "two", text: "Второй", done: false },
      ],
    },
  };
  const e = seed([task]);
  e.pointerDown({ x: 325, y: 288 }, 1, sample(0, 0), 0, false);
  expect(e.elements[0].task!.items.map((i) => i.done)).toEqual([true, false]);
  e.undo();
  expect(e.elements).toEqual([task]);
});
it("slide ordering survives edits, ignores hidden frames and restores with undo", () => {
  const f = (id: string, i: number) => ({
    ...createElement("frame", i * 300, 0, DEFAULT_STYLE),
    id,
    text: id,
    width: 250,
    height: 200,
    createdAt: i,
  });
  const e = seed([
    f("one", 1),
    f("two", 2),
    { ...f("hidden", 3), hidden: true },
  ]);
  e.reorderSlide("two", -1);
  expect(e.slides.map((e) => e.id)).toEqual(["two", "one"]);
  e.undo();
  expect(e.slides.map((e) => e.id)).toEqual(["one", "two"]);
});
describe("table clipboard", () => {
  it("reads quoted multiline Excel cells and CRLF without phantom final rows", () =>
    expect(
      parseTsv('Имя\tЗаметка\r\nИра\t"Первая\nВторая\tс ""цитатой"""\r\n'),
    ).toEqual([
      ["Имя", "Заметка"],
      ["Ира", 'Первая\nВторая\tс "цитатой"'],
    ]));
  it("pads rectangular cells and grows at the chosen insertion point without destroying surrounding text", () => {
    const incoming = parseTsv("1\t2\n3");
    expect(
      pasteCells(
        [
          ["a", "b"],
          ["c", "d"],
        ],
        incoming,
        1,
        1,
      ),
    ).toEqual([
      ["a", "b", ""],
      ["c", "1", "2"],
      ["", "3", ""],
    ]);
  });
  it("rejects oversized and unterminated clipboard data", () => {
    expect(() => parseTsv('"bad')).toThrow();
    expect(() => parseTsv(Array(101).fill("x").join("\n"))).toThrow();
    expect(() => pasteCells([[""]], [["a", "b"]], 0, 49)).toThrow();
  });
});
describe("format three validation", () => {
  const valid = () => ({
    ...createDocument(),
    elements: [
      {
        ...createElement("table", 0, 0, DEFAULT_STYLE),
        width: 200,
        height: 100,
        cells: [
          ["Кириллица", "日本語"],
          ["", "x"],
        ],
        name: "Таблица",
        rotation: 25,
        hidden: false,
      },
      {
        ...createElement("task", 300, 0, DEFAULT_STYLE),
        width: 300,
        height: 200,
        task: {
          status: "doing" as const,
          due: "2026-11-03",
          items: [{ id: "item", text: "Сделать", done: true }],
        },
      },
      {
        ...createElement("link", 600, 0, DEFAULT_STYLE),
        width: 300,
        height: 100,
        link: { path: "C:\\Проекты\\Доска.lightpen", elementId: "target" },
      },
    ],
  });
  it("round-trips tables, checklists, rotation, names and file/object links", () => {
    const doc = valid();
    expect(validateDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });
  it.each(["cells", "rotation", "hidden", "task", "link"])(
    "rejects damaged %s metadata",
    (key) => {
      const doc = valid();
      if (key === "cells")
        (doc.elements[0] as SceneElement).cells = [["x"], ["x", "y"]];
      if (key === "rotation") doc.elements[0].rotation = NaN;
      if (key === "hidden") Object.assign(doc.elements[0], { hidden: "yes" });
      if (key === "task")
        Object.assign(doc.elements[1], {
          task: { status: "other", items: [] },
        });
      if (key === "link")
        Object.assign(doc.elements[2], { link: { path: "bad\0file" } });
      expect(() => validateDocument(doc)).toThrow();
    },
  );
});
it("palette HSV and RGB/HEX preserve primary, grey and arbitrary colors without rounding drift", () => {
  for (const hex of [
    "#000000",
    "#ffffff",
    "#808080",
    "#ff0000",
    "#00ff00",
    "#0000ff",
    "#125a9f",
    "#a8bd63",
  ]) {
    expect(hsvToHex(...hexToHsv(hex))).toBe(hex);
  }
});
it("detoured connector labels have a rectangular hit area at the drawn midpoint", () => {
  const el = {
    ...createElement("arrow", 100, 100, DEFAULT_STYLE),
    endX: 300,
    endY: 0,
    width: 300,
    height: 0,
    connectorStyle: "orthogonal" as const,
    route: [
      { x: 0, y: 0 },
      { x: 0, y: 400 },
      { x: 300, y: 400 },
      { x: 300, y: 0 },
    ],
    label: "Подпись",
    fontSize: 20,
  };
  expect(hitTest(el, { x: 250, y: 510 }, 2)).toBe(true);
  expect(hitTest(el, { x: 250, y: 550 }, 2)).toBe(false);
  expect(sweepHitTest(el, { x: 150, y: 510 }, { x: 350, y: 510 }, 2)).toBe(true);
});
