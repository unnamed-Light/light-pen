import { expect, test } from "vitest";
import * as Y from "yjs";
import { SharedBoard, LOCAL } from "./shared";
import {
  createDocument,
  createElement,
  DEFAULT_STYLE,
} from "../editor/model/types";
const fixture = () => ({
  ...createDocument(),
  elements: [{ ...createElement("text", 0, 0, DEFAULT_STYLE), text: "abcdef" }],
});
function peers() {
  const a = new SharedBoard();
  a.seed(fixture());
  const b = new SharedBoard();
  b.apply(a.encode());
  return { a, b, base: a.snapshot() };
}
function sync(a: SharedBoard, b: SharedBoard) {
  const ua = a.encode(Y.encodeStateVector(b.doc)),
    ub = b.encode(Y.encodeStateVector(a.doc));
  a.apply(ub);
  b.apply(ua);
}
test("independent property edits, text insertions and ordering converge without whole-board replacement", () => {
  const { a, b, base } = peers();
  a.patch(base, {
    ...base,
    elements: base.elements.map((e) => ({ ...e, x: 100, text: "Xabcdef" })),
  });
  b.patch(base, {
    ...base,
    elements: base.elements.map((e) => ({
      ...e,
      color: "#ff0000",
      text: "abcdefY",
    })),
  });
  sync(a, b);
  expect(a.snapshot().elements).toEqual(b.snapshot().elements);
  expect(a.snapshot().elements[0]).toMatchObject({
    x: 100,
    color: "#ff0000",
    text: "XabcdefY",
  });
});
test("offline editing a deleted object cannot resurrect it or erase unrelated new objects", () => {
  const { a, b, base } = peers();
  a.patch(base, { ...base, elements: [] });
  b.patch(base, {
    ...base,
    elements: [
      { ...base.elements[0], x: 300 },
      createElement("sticky", 200, 0, DEFAULT_STYLE),
    ],
  });
  sync(a, b);
  expect(a.snapshot().elements).toEqual(b.snapshot().elements);
  expect(a.snapshot().elements).toHaveLength(1);
  expect(a.snapshot().elements[0].kind).toBe("sticky");
});
test("own undo preserves remote property edits and redo converges", () => {
  const { a, b, base } = peers();
  const undo = new Y.UndoManager([a.meta, a.elements], {
    trackedOrigins: new Set([LOCAL]),
    captureTimeout: 0,
  });
  a.patch(base, {
    ...base,
    elements: base.elements.map((e) => ({ ...e, x: 100 })),
  });
  sync(a, b);
  const bp = b.snapshot();
  b.patch(bp, {
    ...bp,
    elements: bp.elements.map((e) => ({ ...e, color: "#ff0000" })),
  });
  sync(a, b);
  undo.undo();
  sync(a, b);
  expect(a.snapshot().elements[0]).toMatchObject({ x: 0, color: "#ff0000" });
  undo.redo();
  sync(a, b);
  expect(a.snapshot().elements[0]).toMatchObject({ x: 100, color: "#ff0000" });
  undo.destroy();
});
test("duplicate and reordered delivery is idempotent and survives persisted binary reload", () => {
  const { a, b, base } = peers();
  const packets: Uint8Array[] = [];
  a.doc.on("update", (u) => packets.push(u));
  a.patch(base, {
    ...base,
    elements: base.elements.map((e) => ({ ...e, x: 44 })),
  });
  a.patch(a.snapshot(), { ...a.snapshot(), title: "Новое имя" });
  for (const p of [...packets].reverse()) {
    b.apply(p);
    b.apply(p);
  }
  const c = new SharedBoard();
  c.apply(b.encode());
  expect(c.snapshot().elements).toEqual(a.snapshot().elements);
  expect(c.snapshot().title).toBe("Новое имя");
});
test("snapshot cache retains unchanged object identity, invalidates deep edits and reports exact UTF-8 bytes", () => {
  const a = new SharedBoard();
  a.seed({
    ...fixture(),
    title: "Доска 日本語",
    elements: [
      ...fixture().elements,
      { ...createElement("sticky", 100, 0, DEFAULT_STYLE), text: "Ёж 🦊" },
    ],
  });
  const before = a.snapshot();
  expect(a.jsonBytes).toBe(
    new TextEncoder().encode(JSON.stringify(before)).length,
  );
  const next = {
    ...before,
    elements: before.elements.map((e, i) =>
      i === 0 ? { ...e, text: "Другой текст" } : e,
    ),
  };
  a.patch(before, next);
  const after = a.snapshot();
  expect(after.elements[1]).toBe(before.elements[1]);
  expect(after.elements[0]).not.toBe(before.elements[0]);
  expect(a.jsonBytes).toBe(
    new TextEncoder().encode(JSON.stringify(after)).length,
  );
  a.elements.get(after.elements[0].id)!.set("opacity", 2);
  expect(() => a.snapshot()).toThrow();
  expect(() => a.snapshot()).toThrow();
  a.elements.get(after.elements[0].id)!.set("opacity", 1);
  expect(a.snapshot().elements[0].opacity).toBe(1);
  a.destroy();
});
