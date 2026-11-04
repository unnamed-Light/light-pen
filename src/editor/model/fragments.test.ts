import { describe, expect, it } from "vitest";
import {
  buildFragment,
  FRAGMENT_PREFIX,
  importFragmentElements,
  parseFragment,
} from "./fragments";
import { createDocument, createElement, DEFAULT_STYLE } from "./types";
import type { ElementKind, SceneElement } from "./types";

const element = (
  id: string,
  kind: ElementKind,
  x = 100,
  y = 100,
): SceneElement => ({
  ...createElement(kind, x, y, DEFAULT_STYLE),
  id,
  width: 100,
  height: 80,
});
const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==";

describe("Portable fragments", () => {
  it("includes frame contents by default and lets composition exclude them", () => {
    const doc = createDocument("Пространство");
    doc.elements = [
      { ...element("frame", "frame", 0, 0), width: 600, height: 400 },
      element("inside", "sticky"),
      element("outside", "rectangle", 550, 100),
      { ...element("hidden", "image", 300, 200), dataUrl: pixel, hidden: true },
    ];
    const expanded = buildFragment(doc, ["frame"]);
    expect(expanded.elements.map((e) => e.id)).toEqual([
      "frame",
      "inside",
      "hidden",
    ]);
    expect(
      buildFragment(doc, ["frame"], {
        includeFrameContents: false,
      }).elements.map((e) => e.id),
    ).toEqual(["frame"]);
    expect(expanded.elements[2].dataUrl).toBe(pixel);
  });

  it("preserves editable assets and remaps all internal identities without aliases", () => {
    const doc = createDocument("Формулы, таблицы и задачи");
    doc.elements = [
      {
        ...element("a", "task"),
        task: {
          status: "todo",
          items: [{ id: "item", text: "Пункт", done: false }],
          dependencies: ["b"],
        },
        groupId: "outer",
        groupPath: ["outer", "inner"],
      },
      {
        ...element("b", "task", 300),
        task: { status: "doing", items: [] },
        groupId: "outer",
        groupPath: ["outer", "inner"],
      },
      {
        ...element("arrow", "arrow"),
        endX: 200,
        endY: 0,
        startBinding: { elementId: "a", side: "right" },
        endBinding: { elementId: "b", side: "left" },
        connectorStyle: "curve",
      },
      {
        ...element("table", "table"),
        cells: [
          ["Название", "Число"],
          ["Яблоко", "42"],
        ],
        grid: {
          rows: ["h", "r"],
          columns: [
            { id: "name", type: "text" },
            { id: "number", type: "number" },
          ],
        },
      },
      { ...element("image", "image"), dataUrl: pixel },
      { ...element("formula", "math"), text: "\\frac{a}{b}" },
      {
        ...element("link", "link"),
        link: { path: "", pageId: "main", elementId: "a" },
      },
      {
        ...element("widget", "rectangle"),
        widget: {
          pluginId: "example.widget",
          type: "card",
          version: 1,
          data: { text: "Данные" },
          fallback: "Доступно без плагина",
        },
      },
    ];
    const source = JSON.stringify(doc);
    const fragment = parseFragment(
      FRAGMENT_PREFIX +
        JSON.stringify(
          buildFragment(
            doc,
            doc.elements.map((e) => e.id),
          ),
        ),
    );
    const imported = importFragmentElements(fragment, {
      pageId: "destination",
      at: { x: 700, y: 400 },
    });
    const [a, b, arrow, table, image, math, link, widget] = imported.elements;
    expect(a.id).not.toBe("a");
    expect(a.groupId).not.toBe("outer");
    expect(a.groupPath).toEqual(b.groupPath);
    expect(a.task!.dependencies).toEqual([b.id]);
    expect(a.task!.items[0].id).not.toBe("item");
    expect(arrow.startBinding?.elementId).toBe(a.id);
    expect(arrow.endBinding?.elementId).toBe(b.id);
    expect(table.grid!.rows.every((id) => !["h", "r"].includes(id))).toBe(true);
    expect(
      table.grid!.columns.every((c) => !["name", "number"].includes(c.id)),
    ).toBe(true);
    expect(table.cells).toEqual(doc.elements[3].cells);
    expect(image.dataUrl).toBe(pixel);
    expect(math.text).toBe("\\frac{a}{b}");
    expect(link.link).toEqual({
      path: "",
      pageId: "destination",
      elementId: a.id,
    });
    expect(widget.widget?.fallback).toBe("Доступно без плагина");
    expect(widget.widget?.data).toEqual({ text: "Данные" });
    a.task!.items[0].text = "Изменён импорт";
    expect(JSON.stringify(doc)).toBe(source);
    expect(fragment.elements[0].task!.items[0].text).toBe("Пункт");
    expect(imported.elements.every((e) => e.pageId === "destination")).toBe(
      true,
    );
  });

  it("warns about external references and cannot bind the imported copy to unrelated objects", () => {
    const doc = createDocument();
    doc.elements = [
      {
        ...element("arrow", "arrow"),
        endX: 10,
        endY: 10,
        startBinding: { elementId: "outside", side: "left" },
      },
      {
        ...element("task", "task"),
        task: { status: "todo", items: [], dependencies: ["outside"] },
      },
      { ...element("link", "link"), link: { path: "", elementId: "outside" } },
      {
        ...element("file", "link"),
        link: { path: "C:\\Документы\\source.pdf", label: "Документ" },
      },
    ];
    const fragment = buildFragment(
      doc,
      doc.elements.map((e) => e.id),
    );
    expect(fragment.warnings.map((w) => w.kind)).toEqual([
      "binding",
      "dependency",
      "link",
      "link",
    ]);
    const imported = importFragmentElements(fragment, { pageId: "main" });
    expect(imported.elements[0].startBinding).toBeUndefined();
    expect(imported.elements[1].task!.dependencies).toEqual([]);
    expect(imported.elements[2].link?.elementId).toBeUndefined();
    expect(imported.elements[2].link?.pageId).toBeUndefined();
    expect(imported.elements[3].link?.path).toBe("C:\\Документы\\source.pdf");
  });

  it("rejects unknown formats and malformed objects before producing an import", () => {
    const doc = createDocument();
    doc.elements = [element("note", "sticky")];
    const fragment = buildFragment(doc, ["note"]);
    expect(() => parseFragment("{broken")).toThrow("JSON");
    expect(() =>
      parseFragment(JSON.stringify({ ...fragment, version: 2 })),
    ).toThrow("Версия");
    expect(() =>
      parseFragment(
        JSON.stringify({
          ...fragment,
          elements: [{ ...fragment.elements[0], width: -10 }],
        }),
      ),
    ).toThrow();
    const source = JSON.stringify(fragment);
    expect(() =>
      importFragmentElements(fragment, { pageId: "unknown/page" }),
    ).toThrow();
    expect(JSON.stringify(fragment)).toBe(source);
  });
});
