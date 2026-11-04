import { describe, expect, it } from "vitest";
import {
  createDocument,
  createElement,
  DEFAULT_STYLE,
} from "../editor/model/types";
import type { BoardDocument, SceneElement } from "../editor/model/types";
import {
  captureExportSnapshot,
  EXPORT_LIMITS,
  planExport,
  safeExportName,
} from "./plan";
import type { ExportRequest } from "./plan";

const rect = (id: string, pageId?: string): SceneElement => ({
  ...createElement("rectangle", 100, 50, DEFAULT_STYLE),
  id,
  pageId,
  width: 200,
  height: 100,
  strokeWidth: 0,
});
function document(elements = [rect("one")]): BoardDocument {
  return {
    ...createDocument("Экспорт / тест"),
    schemaVersion: 5,
    pages: [
      { id: "first", title: "Первая" },
      { id: "second", title: "Вторая" },
    ],
    elements,
  };
}
const request: ExportRequest = {
  format: "png",
  scope: "page",
  scale: 1,
  padding: 0,
};

describe("workspace export preflight", () => {
  it("captures nested data and selection once without freezing or modifying the live document", () => {
    const doc = document([{ ...rect("one"), cells: [["Исходник"]] }]);
    const selected = new Set(["one"]);
    const snapshot = captureExportSnapshot(doc, {
      activePageId: "first",
      selectionIds: selected,
    });
    doc.elements[0].x = 999;
    doc.elements[0].cells![0][0] = "Изменено";
    selected.clear();
    expect(snapshot.document.elements[0].x).toBe(100);
    expect(snapshot.document.elements[0].cells![0][0]).toBe("Исходник");
    expect(snapshot.selectionIds).toEqual(["one"]);
    expect(Object.isFrozen(snapshot.document.elements[0].cells![0])).toBe(true);
    expect(Object.isFrozen(doc.elements[0])).toBe(false);
  });

  it("exports legacy elements only on the first page and never includes a hidden object", () => {
    const snapshot = captureExportSnapshot(
      document([
        rect("legacy"),
        { ...rect("hidden"), hidden: true, width: 10000 },
        rect("other", "second"),
      ]),
      { activePageId: "first" },
    );
    const first = planExport(snapshot, request);
    expect([first.width, first.height]).toEqual([200, 100]);
    const second = planExport(snapshot, { ...request, pageId: "second" });
    expect(second.pages[0].pageId).toBe("second");
    expect(first.pages[0].estimatedVectorBytes).toBe(
      second.pages[0].estimatedVectorBytes,
    );
  });

  it("uses actual 1x, 2x and 4x dimensions with no automatic reduction", () => {
    const snapshot = captureExportSnapshot(document());
    for (const scale of [1, 2, 4]) {
      const plan = planExport(snapshot, { ...request, scale });
      expect([plan.width, plan.height]).toEqual([200 * scale, 100 * scale]);
    }
  });

  it("preserves proportions for exact width/height and rejects conflicting dimensions", () => {
    const snapshot = captureExportSnapshot(document());
    expect(planExport(snapshot, { ...request, pixelWidth: 333 }).height).toBe(
      167,
    );
    expect(planExport(snapshot, { ...request, pixelHeight: 150 }).width).toBe(
      300,
    );
    expect(() =>
      planExport(snapshot, { ...request, pixelWidth: 400, pixelHeight: 400 }),
    ).toThrow(/пропорции/);
    expect(() => planExport(snapshot, { ...request, pixelWidth: 0 })).toThrow(
      /положительное/,
    );
  });

  it("accepts 64MP at the documented boundary and rejects a larger result before rasterization", () => {
    const snapshot = captureExportSnapshot(document());
    const region = { x: -100, y: -200, width: 16000, height: 4000 };
    const plan = planExport(snapshot, { ...request, scope: "region", region });
    expect(plan.totalPixels).toBe(EXPORT_LIMITS.rasterPixels);
    expect([plan.width, plan.height]).toEqual([16000, 4000]);
    expect(() =>
      planExport(snapshot, { ...request, scope: "region", region, scale: 2 }),
    ).toThrow(/Качество автоматически не уменьшается/);
    expect(() =>
      planExport(snapshot, {
        ...request,
        scope: "region",
        region: { ...region, width: 16385, height: 1 },
      }),
    ).toThrow(/16 384/);
  });

  it("keeps empty pages and requested order in a multipage PDF", () => {
    const snapshot = captureExportSnapshot(document());
    const plan = planExport(snapshot, {
      format: "pdf",
      scope: "pages",
      pageIds: ["second", "first"],
      padding: 0,
    });
    expect(plan.pages.map((p) => p.pageId)).toEqual(["second", "first"]);
    expect(plan.pages[0].empty).toBe(true);
    expect([plan.pages[0].width, plan.pages[0].height]).toEqual([800, 600]);
    expect(plan.warnings).toHaveLength(1);
  });

  it("plans a single PNG layout without overlap and applies a custom size to the whole layout", () => {
    const snapshot = captureExportSnapshot(
      document([rect("one"), rect("two", "second")]),
    );
    const plan = planExport(snapshot, {
      ...request,
      scope: "workspace",
      pixelWidth: 900,
      layout: { columns: 2, gap: 50 },
    });
    expect([plan.width, plan.height]).toEqual([900, 200]);
    expect(
      plan.pages.map((p) => [p.x, p.y, p.pixelWidth, p.pixelHeight]),
    ).toEqual([
      [0, 0, 400, 200],
      [500, 0, 400, 200],
    ]);
    expect(plan.pages[0].x + plan.pages[0].pixelWidth).toBeLessThan(
      plan.pages[1].x,
    );
  });

  it("rejects missing pages, hidden frames and an empty selection instead of widening the scope", () => {
    const frame = { ...rect("frame"), kind: "frame" as const, hidden: true };
    const snapshot = captureExportSnapshot(document([rect("one"), frame]));
    expect(() =>
      planExport(snapshot, { ...request, pageId: "missing" }),
    ).toThrow(/не существует/);
    expect(() =>
      planExport(snapshot, { ...request, scope: "frame", frameId: "frame" }),
    ).toThrow(/скрыт/);
    expect(() =>
      planExport(snapshot, { ...request, scope: "selection" }),
    ).toThrow(/Выделите/);
    expect(() =>
      planExport(snapshot, {
        ...request,
        scope: "pages",
        pageIds: ["first", "first"],
      }),
    ).toThrow(/повторений/);
  });

  it("makes paper fitting explicit for a very large PDF page", () => {
    const snapshot = captureExportSnapshot(document());
    const large = {
      format: "pdf",
      scope: "region",
      region: { x: 0, y: 0, width: 20000, height: 10000 },
    } as const;
    expect(() => planExport(snapshot, large)).toThrow(/A4\/A3/);
    const plan = planExport(snapshot, { ...large, pdfPageSize: "a4" });
    expect(plan.pages[0].pdfWidth).toBe(841.89);
    expect(plan.pages[0].pdfHeight).toBe(595.28);
  });

  it("does not impose an artificial page-count limit on sequential ZIP generation", () => {
    const doc = document([]);
    doc.pages = Array.from({ length: 300 }, (_, i) => ({
      id: `p${i}`,
      title: `Страница ${i}`,
    }));
    const plan = planExport(captureExportSnapshot(doc), {
      format: "zip",
      scope: "workspace",
      scale: 1,
    });
    expect(plan.pages).toHaveLength(300);
    expect(plan.estimatedWorkingBytes).toBeLessThan(EXPORT_LIMITS.workingBytes);
    expect(new Set(plan.pages.map((p) => p.filename)).size).toBe(300);
  });

  it("uses safe unique archive names without paths or Windows device names", () => {
    expect(safeExportName("../CON. ")).not.toMatch(/[\/\\]/);
    expect(safeExportName("CON")).toBe("_CON");
    expect(safeExportName("a\\b/:c<>?*")).toBe("a b c");
    const doc = document([]);
    doc.pages!.forEach((p) => (p.title = "Одинаковые"));
    const plan = planExport(captureExportSnapshot(doc), {
      format: "zip",
      scope: "workspace",
    });
    expect(plan.pages[0].filename).not.toBe(plan.pages[1].filename);
  });

  it("rejects invalid region/scale and does not mutate request parameters", () => {
    const snapshot = captureExportSnapshot(document());
    const input = {
      ...request,
      scope: "workspace" as const,
      layout: { columns: 2, gap: 10 },
    };
    const before = structuredClone(input);
    planExport(snapshot, input);
    expect(input).toEqual(before);
    expect(() => planExport(snapshot, { ...request, scale: NaN })).toThrow(
      /Масштаб/,
    );
    expect(() =>
      planExport(snapshot, {
        ...request,
        scope: "region",
        region: { x: 0, y: 0, width: -10, height: 20 },
      }),
    ).toThrow(/положительное/);
  });
});
