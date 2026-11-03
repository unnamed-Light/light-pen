import { beforeEach, describe, expect, it } from "vitest";
import { Editor, exampleDocument } from "./editor";
import {
  createDocument,
  createElement,
  DEFAULT_STYLE,
  validateDocument,
} from "./model/types";
import type { SceneElement } from "./model/types";

let editor: Editor;
const sample = (
  x: number,
  y: number,
  pressure = 0.5,
  time = 1,
  pointerType = "mouse",
) => ({ x, y, pressure, time, pointerType });
const down = (x: number, y: number, shift = false) =>
  editor.pointerDown({ x, y }, 1, sample(x, y), 0, shift);
const move = (x: number, y: number, shift = false) =>
  editor.pointerMove({ x, y }, 1, sample(x, y, 0.5, 20), shift);
const up = () => editor.pointerUp(1);
beforeEach(() => {
  editor = new Editor();
  editor.camera = { x: 0, y: 0, zoom: 1 };
});

describe("drawing transactions", () => {
  it("stores one undo step for an entire pen gesture and preserves pressure", () => {
    editor.pointerDown(
      { x: 20, y: 30 },
      1,
      sample(20, 30, 0.1, 0, "pen"),
      0,
      false,
    );
    for (let i = 1; i <= 200; i++)
      editor.pointerMove(
        { x: 20 + i, y: 30 + i / 2 },
        1,
        sample(20 + i, 30 + i / 2, i / 200, i * 3, "pen"),
        false,
      );
    expect(editor.document.elements).toHaveLength(0);
    up();
    expect(editor.elements).toHaveLength(1);
    expect(editor.elements[0].points!.length).toBe(201);
    expect(editor.elements[0].points![100][2]).toBeGreaterThan(0.45);
    validateDocument(editor.document);
    editor.undo();
    expect(editor.elements).toHaveLength(0);
    expect(editor.history.canUndo).toBe(false);
    editor.redo();
    expect(editor.elements).toHaveLength(1);
  });
  it("renders a click as a valid dot", () => {
    down(10, 10);
    up();
    expect(editor.elements[0].points).toHaveLength(1);
    validateDocument(editor.document);
  });
  it("ignores competing pointer streams and cancels a gesture without a document change", () => {
    down(0, 0);
    editor.pointerMove({ x: 500, y: 500 }, 2, sample(500, 500), false);
    expect(editor.gesture?.type).toBe("ink");
    editor.cancelGesture();
    expect(editor.elements).toHaveLength(0);
    expect(editor.history.canUndo).toBe(false);
  });
  it.each(["rectangle", "ellipse", "diamond", "arrow", "line"] as const)(
    "creates %s in reverse direction and restores it",
    (tool) => {
      editor.setTool(tool);
      down(100, 100);
      move(20, 40);
      up();
      const e = editor.elements[0];
      expect(e.width).toBe(80);
      expect(e.height).toBe(60);
      validateDocument(editor.document);
      editor.undo();
      expect(editor.elements).toHaveLength(0);
      editor.redo();
      expect(editor.elements[0]).toEqual(e);
    },
  );
  it("constrains shapes and arrows with Shift", () => {
    editor.setTool("rectangle");
    down(0, 0);
    move(80, 20, true);
    up();
    expect(editor.elements[0].width).toBe(editor.elements[0].height);
    editor.setTool("arrow");
    down(0, 0);
    move(90, 18, true);
    up();
    expect(editor.elements[1].endY).toBeCloseTo(0);
  });
  it("marker opacity and thickness are independent from pen settings", () => {
    editor.setTool("highlighter");
    down(0, 0);
    move(100, 0);
    up();
    expect(editor.elements[0].opacity).toBe(0.32);
    expect(editor.elements[0].strokeWidth).toBeGreaterThanOrEqual(14);
    editor.setTool("pen");
    down(0, 20);
    up();
    expect(editor.elements[1].opacity).toBe(1);
    expect(editor.elements[1].strokeWidth).toBe(3);
  });
});

describe("editing objects", () => {
  const rect = (x = 10, y = 10): SceneElement => ({
    ...createElement("rectangle", x, y, { ...DEFAULT_STYLE, fill: "#fff1a8" }),
    width: 100,
    height: 80,
  });
  it("moves selection as a single action and undo restores exact coordinates", () => {
    const e = rect();
    editor.commit([e], "setup");
    editor.setTool("select");
    down(50, 50);
    move(80, 100);
    up();
    expect(editor.elements[0].x).toBe(40);
    expect(editor.elements[0].y).toBe(60);
    editor.undo();
    expect(editor.elements[0]).toBe(e);
  });
  it("cancels a move and erasure cleanly", () => {
    const e = rect();
    editor.commit([e], "setup");
    editor.setTool("select");
    down(50, 50);
    move(70, 60);
    editor.cancelGesture();
    expect(editor.elements[0]).toBe(e);
    editor.setTool("eraser");
    down(50, 50);
    expect(editor.hiddenIds.has(e.id)).toBe(true);
    editor.cancelGesture();
    expect(editor.hiddenIds.size).toBe(0);
    expect(editor.elements).toHaveLength(1);
  });
  it("groups multiple erasures in one undo step", () => {
    editor.commit([rect(0, 0), rect(200, 0)], "setup");
    editor.setTool("eraser");
    down(50, 40);
    move(250, 40);
    up();
    expect(editor.elements).toHaveLength(0);
    editor.undo();
    expect(editor.elements).toHaveLength(2);
  });
  it("supports marquee, duplicate, copy and paste with fresh IDs", () => {
    editor.commit([rect(50, 50), rect(250, 50)], "setup");
    editor.setTool("select");
    down(0, 0);
    move(400, 200);
    up();
    expect(editor.selected.size).toBe(2);
    editor.copy();
    editor.paste();
    expect(editor.elements).toHaveLength(4);
    expect(new Set(editor.elements.map((e) => e.id)).size).toBe(4);
    editor.duplicate();
    expect(editor.elements).toHaveLength(6);
    editor.deleteSelection();
    expect(editor.elements).toHaveLength(4);
    validateDocument(editor.document);
  });
  it("commits multiline Unicode text once and keeps a reasonable height", () => {
    editor.setTool("text");
    down(100, 100);
    editor.updateText("Привет, мир!\n日本語 ✨");
    editor.commitText();
    expect(editor.elements[0].text).toContain("日本語");
    expect(editor.elements[0].height).toBeGreaterThan(40);
    expect(editor.elements[0].height).toBeLessThan(150);
    editor.undo();
    expect(editor.elements).toHaveLength(0);
  });
  it("cancels empty text and a cancelled edit does not erase existing text", () => {
    editor.setTool("text");
    down(100, 100);
    up();
    editor.commitText();
    expect(editor.elements).toHaveLength(0);
    editor.setTool("sticky");
    down(100, 100);
    up();
    editor.updateText("Saved");
    editor.commitText();
    const e = editor.elements[0];
    editor.startText(e, false);
    editor.updateText("Unsaved");
    editor.cancelText();
    expect(editor.elements[0].text).toBe("Saved");
  });
  it("creates a sticky with the dragged area in either direction as one undo action", () => {
    for (const reverse of [false, true]) {
      editor = new Editor();
      editor.camera = { x: 0, y: 0, zoom: 1 };
      editor.setTool("sticky");
      down(reverse ? 500 : 100, reverse ? 350 : 100);
      move(reverse ? 100 : 500, reverse ? 100 : 350);
      expect(editor.editing).toBeNull();
      up();
      expect(editor.editing!.element).toMatchObject({
        kind: "sticky",
        x: 100,
        y: 100,
        width: 400,
        height: 250,
      });
      editor.updateText("Свой размер");
      editor.commitText();
      expect(editor.elements[0]).toMatchObject({
        width: 400,
        height: 250,
        text: "Свой размер",
      });
      editor.undo();
      expect(editor.elements).toHaveLength(0);
      editor.redo();
      expect(editor.elements[0].width).toBe(400);
      validateDocument(editor.document);
    }
  });
  it("sticky clicks retain the default size and tiny areas have a readable minimum", () => {
    editor.setTool("sticky");
    down(200, 200);
    up();
    expect(editor.editing!.element).toMatchObject({ width: 220, height: 180 });
    editor.commitText();
    expect(editor.elements[0]).toMatchObject({
      kind: "sticky",
      text: "",
      width: 220,
      height: 180,
    });
    editor.undo();
    down(200, 200);
    move(190, 185);
    up();
    expect(editor.editing!.element).toMatchObject({
      x: 120,
      y: 120,
      width: 80,
      height: 80,
    });
    editor.cancelText();
    down(100, 100);
    move(500, 400);
    editor.cancelGesture();
    up();
    expect(editor.editing).toBeNull();
    expect(editor.elements).toHaveLength(0);
  });
  it("sticky region dimensions use board coordinates at non-default zoom", () => {
    editor.camera = { x: 100, y: 50, zoom: 2 };
    editor.setTool("sticky");
    down(300, 250);
    move(900, 650);
    up();
    expect(editor.editing!.element).toMatchObject({
      x: 100,
      y: 100,
      width: 300,
      height: 200,
    });
  });
  it("clears undo and transient selection on document changes", () => {
    editor.commit([rect()], "setup");
    editor.selectAll();
    editor.setDocument(createDocument());
    expect(editor.history.canUndo).toBe(false);
    expect(editor.selected.size).toBe(0);
    expect(editor.elements).toHaveLength(0);
  });
  it("keeps document unchanged during replay, supports pause and seeking", () => {
    editor.setDocument(exampleDocument());
    const before = JSON.stringify(editor.document);
    editor.startReplay();
    editor.tickReplay(1);
    editor.tickReplay(500);
    expect(editor.replay!.progress).toBeGreaterThan(0);
    editor.toggleReplay();
    const progress = editor.replay!.progress;
    editor.tickReplay(1000);
    expect(editor.replay!.progress).toBe(progress);
    editor.seekReplay(1);
    editor.stopReplay();
    expect(JSON.stringify(editor.document)).toBe(before);
  });
});

describe("document validation", () => {
  it("accepts the example and round trips JSON", () => {
    const doc = exampleDocument();
    expect(validateDocument(JSON.parse(JSON.stringify(doc)))).toEqual(doc);
  });
  it("rejects future format, duplicate IDs, invalid pressure and nonfinite coordinates", () => {
    const doc = exampleDocument();
    expect(() => validateDocument({ ...doc, schemaVersion: 99 })).toThrow();
    expect(() =>
      validateDocument({
        ...doc,
        elements: [doc.elements[0], doc.elements[0]],
      }),
    ).toThrow();
    const stroke = {
      ...createElement("stroke", 0, 0, DEFAULT_STYLE),
      points: [[0, 0, 2, 0]],
    };
    expect(() => validateDocument({ ...doc, elements: [stroke] })).toThrow();
    expect(() =>
      validateDocument({
        ...doc,
        elements: [{ ...doc.elements[0], x: Infinity }],
      }),
    ).toThrow();
  });
  it("rejects script-like colors and remote image URLs", () => {
    const doc = exampleDocument();
    expect(() =>
      validateDocument({
        ...doc,
        elements: [{ ...doc.elements[0], color: "url(https://example.com)" }],
      }),
    ).toThrow();
    expect(() =>
      validateDocument({
        ...doc,
        elements: [
          {
            ...doc.elements[0],
            kind: "image",
            dataUrl: "https://example.com/pic.png",
          },
        ],
      }),
    ).toThrow();
  });
});
