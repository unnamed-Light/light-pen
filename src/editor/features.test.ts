import { beforeEach, expect, it } from "vitest";
import { Editor } from "./editor";
import {
  createDocument,
  createElement,
  DEFAULT_STYLE,
  validateDocument,
} from "./model/types";
import type { SceneElement } from "./model/types";
import { anchor, resolveBindings } from "./model/relations";
import { bounds } from "./model/geometry";
let e: Editor;
it("restoring a version returns its title and undo restores the replaced title", () => {
  const editor = new Editor();
  editor.document = { ...createDocument("Текущая"), elements: [] };
  const old = rect("restored", 100, 100);
  editor.commit([old], "Восстановление версии", "Начальная");
  expect(editor.document.title).toBe("Начальная");
  editor.undo();
  expect(editor.document.title).toBe("Текущая");
  expect(editor.elements).toHaveLength(0);
  editor.redo();
  expect(editor.document.title).toBe("Начальная");
  expect(editor.elements).toHaveLength(1);
});
const rect = (
  id: string,
  x: number,
  y: number,
  width = 100,
  height = 80,
): SceneElement => ({
  ...createElement("rectangle", x, y, DEFAULT_STYLE),
  id,
  width,
  height,
  fill: "#cfe9fd",
});
const sample = (x: number, y: number) => ({
  x,
  y,
  time: 20,
  pressure: 0.5,
  pointerType: "mouse",
});
const down = (x: number, y: number) =>
  e.pointerDown({ x, y }, 1, sample(x, y), 0, false);
const move = (x: number, y: number) =>
  e.pointerMove({ x, y }, 1, sample(x, y), false);
beforeEach(() => {
  e = new Editor();
  e.camera = { x: 0, y: 0, zoom: 1 };
  e.snap = false;
});
it("font slider previews without a revision and commits a single undo for multiple objects", () => {
  const text = (id: string) => ({
    ...createElement("text", 0, 0, DEFAULT_STYLE),
    id,
    text: "Hello",
    width: 200,
    height: 40,
  });
  e.document = {
    ...createDocument(),
    elements: [text("a"), text("b"), rect("c", 0, 0)],
  };
  e.selectAll();
  const before = e.elements;
  e.beginStyle();
  for (let n = 25; n <= 96; n++) e.setStyle({ fontSize: n });
  expect(e.document.revision).toBe(0);
  expect(e.elements[0].fontSize).toBe(96);
  expect(e.elements[2].fontSize).toBeUndefined();
  e.endStyle();
  expect(e.document.revision).toBe(1);
  e.undo();
  expect(e.elements).toEqual(before);
  expect(e.history.canUndo).toBe(false);
  e.redo();
  expect(e.elements[1].fontSize).toBe(96);
});
it("an unchanged style gesture does not consume undo", () => {
  e.beginStyle();
  e.setStyle({ fontSize: 24 });
  e.endStyle();
  expect(e.history.canUndo).toBe(false);
});
it("formatting and group metadata validate while old boards remain readable", () => {
  const a = { ...rect("a", 0, 0), groupId: "group-one", locked: true };
  const b = {
    ...createElement("text", 0, 0, DEFAULT_STYLE),
    id: "b",
    width: 200,
    height: 100,
    text: "文字",
    fontSize: 47,
    bold: true,
    italic: true,
    textAlign: "right" as const,
  };
  const doc = { ...createDocument(), elements: [a, b] };
  expect(validateDocument(doc)).toEqual(doc);
  expect(validateDocument({ ...doc, schemaVersion: 1 })).toBeTruthy();
  expect(() =>
    validateDocument({ ...doc, elements: [{ ...a, locked: "yes" }] }),
  ).toThrow();
  expect(() =>
    validateDocument({ ...doc, elements: [{ ...b, textAlign: "bad" }] }),
  ).toThrow();
});
it("grouping selects and moves every member, then ungroups with one undo", () => {
  e.document = {
    ...createDocument(),
    elements: [rect("a", 100, 100), rect("b", 260, 150)],
  };
  e.selectAll();
  e.group();
  const group = e.elements[0].groupId;
  expect(group).toBeTruthy();
  expect(e.elements[1].groupId).toBe(group);
  e.selected.clear();
  e.setTool("select");
  down(130, 130);
  expect(e.selected.size).toBe(2);
  move(180, 180);
  e.pointerUp(1);
  expect(e.elements[0].x).toBe(150);
  expect(e.elements[1].x).toBe(310);
  e.ungroup();
  expect(e.elements.every((x) => !x.groupId)).toBe(true);
  e.undo();
  expect(e.elements.every((x) => x.groupId === group)).toBe(true);
});
it("locked objects survive erasing, styling and deletion until unlocked", () => {
  e.document = { ...createDocument(), elements: [rect("a", 100, 100)] };
  e.selectAll();
  e.lockSelection();
  expect(e.pick({ x: 120, y: 120 })).toBeNull();
  e.setTool("eraser");
  down(120, 120);
  move(220, 150);
  e.pointerUp(1);
  expect(e.elements).toHaveLength(1);
  e.selected.add("a");
  e.setStyle({ color: "#ff0000" });
  e.deleteSelection();
  expect(e.elements[0].color).toBe(DEFAULT_STYLE.color);
  e.unlockAll();
  e.deleteSelection();
  expect(e.elements).toHaveLength(0);
  e.undo();
  expect(e.elements).toHaveLength(1);
});
it("connectors follow targets, detach on deletion and recover on undo", () => {
  const a = rect("a", 100, 100),
    b = rect("b", 400, 200);
  const arrow: SceneElement = {
    ...createElement("arrow", 0, 0, DEFAULT_STYLE),
    id: "arrow",
    endX: 1,
    endY: 1,
    width: 1,
    height: 1,
    startBinding: { elementId: "a", side: "right" },
    endBinding: { elementId: "b", side: "left" },
  };
  e.document = {
    ...createDocument(),
    elements: resolveBindings([a, b, arrow]),
  };
  expect(e.elements[2].x).toBe(anchor(a, "right").x);
  e.commit(
    e.elements.map((x) => (x.id === "a" ? { ...x, x: 200, width: 150 } : x)),
    "Move",
  );
  expect(e.elements[2].x).toBe(351.5);
  e.selected = new Set(["b"]);
  const endpoint = e.elements[2].x + e.elements[2].endX!;
  e.deleteSelection();
  expect(e.elements[1].endBinding).toBeUndefined();
  expect(e.elements[1].x + e.elements[1].endX!).toBe(endpoint);
  e.undo();
  expect(e.elements[2].endBinding?.elementId).toBe("b");
  validateDocument(e.document);
});
it("a connector's free endpoint stays under the pointer when its start snaps to a shape", () => {
  e.document = { ...createDocument(), elements: [rect("a", 100, 100)] };
  e.setTool("connector");
  down(190, 140);
  move(350, 160);
  move(450, 190);
  e.pointerUp(1);
  const arrow = e.elements[1];
  expect(arrow.startBinding?.elementId).toBe("a");
  expect(arrow.x + arrow.endX!).toBe(450);
  expect(arrow.y + arrow.endY!).toBe(190);
});
it("copying a connected group remaps all IDs without changing original links", () => {
  const a = rect("a", 100, 100),
    b = rect("b", 400, 100),
    arrow = {
      ...createElement("arrow", 0, 0, DEFAULT_STYLE),
      id: "c",
      width: 1,
      height: 1,
      endX: 1,
      endY: 1,
      startBinding: { elementId: "a", side: "right" as const },
      endBinding: { elementId: "b", side: "left" as const },
    };
  e.document = {
    ...createDocument(),
    elements: resolveBindings([a, b, arrow]),
  };
  e.selectAll();
  e.group();
  const group = e.elements[0].groupId;
  e.copy();
  e.paste();
  const copies = e.elements.slice(3);
  expect(copies[0].groupId).not.toBe(group);
  expect(copies[2].startBinding?.elementId).toBe(copies[0].id);
  expect(copies[2].endBinding?.elementId).toBe(copies[1].id);
  expect(e.elements[2].startBinding?.elementId).toBe("a");
  validateDocument(e.document);
});
it("alignment and distribution treat groups as units and preserve exact undo", () => {
  e.document = {
    ...createDocument(),
    elements: [
      { ...rect("a", 0, 0), groupId: "g" },
      { ...rect("b", 130, 20), groupId: "g" },
      rect("c", 500, 200),
      rect("d", 900, 400),
    ],
  };
  e.selectAll();
  e.align("top");
  expect(e.elements.map((x) => x.y)).toEqual([0, 20, 0, 0]);
  e.undo();
  expect(e.elements[2].y).toBe(200);
  e.align("horizontal");
  expect(e.elements[1].x - e.elements[0].x).toBe(130);
  const gap1 = bounds(e.elements[2]).minX - bounds(e.elements[1]).maxX,
    gap2 = bounds(e.elements[3]).minX - bounds(e.elements[2]).maxX;
  expect(gap1).toBeCloseTo(gap2);
});
it("moving a frame carries its contents while locked and exterior objects stay fixed", () => {
  const frame: SceneElement = {
    ...createElement("frame", 100, 100, DEFAULT_STYLE),
    id: "f",
    text: "Frame",
    width: 500,
    height: 400,
  };
  e.document = {
    ...createDocument(),
    elements: [
      frame,
      rect("a", 200, 200),
      { ...rect("b", 350, 300), locked: true },
      rect("c", 800, 800),
    ],
  };
  e.setTool("select");
  down(120, 112);
  move(170, 162);
  e.pointerUp(1);
  expect(e.elements.map((x) => [x.x, x.y])).toEqual([
    [150, 150],
    [250, 250],
    [350, 300],
    [800, 800],
  ]);
  e.undo();
  expect(e.elements[1].x).toBe(200);
});
it("guides snap moving edges and cancel without document changes", () => {
  e.snap = true;
  e.document = {
    ...createDocument(),
    elements: [rect("a", 100, 100), rect("b", 400, 300)],
  };
  e.setTool("select");
  down(130, 130);
  move(427, 230);
  expect(e.guides.some((g) => g.axis === "x")).toBe(true);
  expect(e.previewElements[0].x).toBe(400);
  e.cancelGesture();
  expect(e.elements[0].x).toBe(100);
  expect(e.guides).toHaveLength(0);
});
it("pen settings are captured per stroke and affect only future input", () => {
  e.pen = { smoothing: 80, stabilization: 55, minWidth: 20, pressure: 200 };
  down(10, 10);
  move(100, 50);
  e.pointerUp(1);
  expect(e.elements[0].ink?.stabilization).toBe(55);
  e.pen = { ...e.pen, stabilization: 12 };
  expect(e.elements[0].ink?.stabilization).toBe(55);
  expect(
    e.pressure({ ...sample(0, 0), pointerType: "pen", pressure: 0.25 }),
  ).toBeCloseTo(0.5);
  validateDocument(e.document);
});
it("formula source stays editable and text size scales formula geometry with undo", () => {
  e.setTool("math");
  down(150, 150);
  e.saveFormula(String.raw`\frac{a}{b}`, 100, 60);
  expect(e.elements[0].kind).toBe("math");
  expect(e.elements[0].text).toBe(String.raw`\frac{a}{b}`);
  e.setStyle({ fontSize: 48 });
  expect(e.elements[0].width).toBe(200);
  e.undo();
  expect(e.elements[0].width).toBe(100);
  validateDocument(e.document);
});
it("resizing a group updates every member and can be undone exactly", () => {
  e.document = {
    ...createDocument(),
    elements: [rect("a", 100, 100), rect("b", 300, 100)],
  };
  e.selectAll();
  e.group();
  const before = e.elements;
  e.setTool("select");
  const b = e.selectionBounds!;
  down(b.maxX, b.maxY);
  move(b.maxX + 200, b.maxY + 100);
  e.pointerUp(1);
  expect(e.elements[0].width).toBeGreaterThan(100);
  expect(e.elements[1].x).toBeGreaterThan(300);
  e.undo();
  expect(e.elements).toEqual(before);
});
it("connector endpoints can be reattached, freed and undone without moving targets", () => {
  const a = rect("a", 100, 100),
    b = rect("b", 400, 200),
    c = rect("c", 700, 400),
    arrow = {
      ...createElement("arrow", 0, 0, DEFAULT_STYLE),
      id: "d",
      width: 1,
      height: 1,
      endX: 1,
      endY: 1,
      startBinding: { elementId: "a", side: "right" as const },
      endBinding: { elementId: "b", side: "left" as const },
    };
  e.document = {
    ...createDocument(),
    elements: resolveBindings([a, b, c, arrow]),
  };
  e.setTool("select");
  e.selected.add("d");
  const end = anchor(b, "left");
  down(end.x, end.y);
  move(701, 440);
  e.pointerUp(1);
  expect(e.elements[3].endBinding?.elementId).toBe("c");
  expect(e.elements[1]).toBe(b);
  e.undo();
  expect(e.elements[3].endBinding?.elementId).toBe("b");
  e.detachConnectors();
  expect(e.elements[3].startBinding).toBeUndefined();
  e.undo();
  expect(e.elements[3].startBinding?.elementId).toBe("a");
});
