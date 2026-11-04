import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { SharedBoard, LOCAL } from "./shared";
import {
  createDocument,
  createElement,
  DEFAULT_STYLE,
  validateDocument,
} from "../editor/model/types";
const fixture = () => ({
  ...createDocument(),
  pages: [
    { id: "main", title: "Первая" },
    { id: "two", title: "Вторая" },
  ],
  elements: [
    {
      ...createElement("sticky", 0, 0, DEFAULT_STYLE),
      id: "one",
      pageId: "main",
      width: 200,
      height: 100,
      text: "A",
    },
    {
      ...createElement("sticky", 0, 0, DEFAULT_STYLE),
      id: "two-item",
      pageId: "two",
      width: 200,
      height: 100,
      text: "B",
    },
  ],
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
describe("collaborative page transactions", () => {
  it("merges page rename/reorder with independent edits on another page", () => {
    const { a, b, base } = peers();
    a.patch(base, {
      ...base,
      pages: [
        { id: "two", title: "Вторая" },
        { id: "main", title: "Обзор" },
      ],
    });
    b.patch(base, {
      ...base,
      elements: base.elements.map((e) =>
        e.id === "two-item" ? { ...e, text: "Новая мысль" } : e,
      ),
    });
    sync(a, b);
    const x = a.snapshot(),
      y = b.snapshot();
    expect(x.pages).toEqual(y.pages);
    expect(x.elements).toEqual(y.elements);
    expect(x.pages?.[0].id).toBe("two");
    expect(x.pages?.[1].title).toBe("Обзор");
    expect(x.elements[1].text).toBe("Новая мысль");
  });
  it("retains a concurrent late object if its page was deleted, and both clients choose the same surviving page", () => {
    const { a, b, base } = peers();
    a.patch(base, {
      ...base,
      pages: base.pages!.filter((p) => p.id !== "two"),
      elements: base.elements.filter((e) => e.pageId !== "two"),
    });
    b.patch(base, {
      ...base,
      elements: [
        ...base.elements,
        { ...base.elements[1], id: "late", text: "Не потерять" },
      ],
    });
    sync(a, b);
    const x = a.snapshot(),
      y = b.snapshot();
    validateDocument(x);
    expect(x.elements).toEqual(y.elements);
    expect(x.pages).toEqual([{ id: "main", title: "Первая" }]);
    expect(x.elements.find((e) => e.id === "late")).toMatchObject({
      pageId: "main",
      text: "Не потерять",
    });
    expect(x.elements.some((e) => e.id === "two-item")).toBe(false);
  });
  it("recovers a valid landing page when peers concurrently delete the last different pages", () => {
    const { a, b, base } = peers();
    a.patch(base, {
      ...base,
      pages: [base.pages![0]],
      elements: base.elements.filter((e) => e.pageId === "main"),
    });
    b.patch(base, {
      ...base,
      pages: [base.pages![1]],
      elements: base.elements.filter((e) => e.pageId === "two"),
    });
    sync(a, b);
    expect(a.snapshot().pages).toEqual([{ id: "main", title: "Страница 1" }]);
    expect(a.snapshot().pages).toEqual(b.snapshot().pages);
    validateDocument(a.snapshot());
  });
  it("undoes a local page deletion without undoing the other participant’s edits", () => {
    const { a, b, base } = peers();
    const undo = new Y.UndoManager([a.meta, a.elements, a.pages], {
      trackedOrigins: new Set([LOCAL]),
      captureTimeout: 0,
    });
    a.patch(base, {
      ...base,
      pages: [base.pages![0]],
      elements: [base.elements[0]],
    });
    sync(a, b);
    const before = b.snapshot();
    b.patch(before, {
      ...before,
      elements: before.elements.map((e) => ({
        ...e,
        text: "Удалённый участник написал",
      })),
    });
    sync(a, b);
    undo.undo();
    sync(a, b);
    const next = a.snapshot();
    expect(next.pages).toHaveLength(2);
    expect(next.elements.find((e) => e.id === "one")?.text).toBe(
      "Удалённый участник написал",
    );
    expect(next.elements.find((e) => e.id === "two-item")?.text).toBe("B");
    expect(next.elements).toEqual(b.snapshot().elements);
    undo.destroy();
  });
});
