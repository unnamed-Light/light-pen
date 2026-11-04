import { describe, it, expect } from "vitest";
import { Editor } from "./editor";
import {
  createDocument,
  createElement,
  DEFAULT_STYLE,
  validateDocument,
} from "./model/types";
import { pageElements, elementPage } from "./model/pages";
import { AgentController } from "../agent/controller";
import { CandidateValidator } from "../agent/validation";

const shape = (id: string) => ({
  ...createElement("rectangle", 10, 20, DEFAULT_STYLE),
  id,
  width: 150,
  height: 100,
});
const ctx = (a: AgentController) => ({
  session: a.grant!.session,
  requestId: crypto.randomUUID(),
  documentId: a.editor.document.id,
  expectedRevision: a.editor.document.revision,
  pageId: a.editor.activePageId,
});
describe("flat workspace pages", () => {
  it("refuses an oversized page duplicate before changing the document or history", () => {
    const e = new Editor(),
      text = "x".repeat(100_000);
    e.setDocument({
      ...createDocument(),
      elements: Array.from({ length: 400 }, (_, i) => ({
        ...createElement("sticky", 0, 0, DEFAULT_STYLE),
        id: "large-" + i,
        width: 200,
        height: 100,
        text,
      })),
    });
    const before = e.document;
    expect(() => e.duplicatePage("main")).toThrow("64 МиБ");
    expect(e.document).toBe(before);
    expect(e.pages).toHaveLength(1);
    expect(e.history.canUndo).toBe(false);
  });
  it("upgrades legacy objects without moving them when the first page is reordered", () => {
    const e = new Editor();
    e.setDocument({
      ...createDocument(),
      schemaVersion: 4,
      pages: undefined,
      elements: [shape("old")],
    });
    const p = e.createPage("Разбор");
    e.reorderPage(p.id, 0);
    expect(elementPage(e.document, e.document.elements[0])).toBe("main");
    expect(e.elements).toEqual([]);
    e.switchPage("main");
    expect(e.elements[0].id).toBe("old");
    validateDocument(e.document);
  });
  it("keeps inactive objects through drawing, style previews, undo and redo", () => {
    const e = new Editor();
    e.commit([shape("first")], "Seed");
    const p = e.createPage("Вторая");
    e.commit([shape("second")], "Insert");
    e.selected = new Set(["second"]);
    e.beginStyle();
    e.setStyle({ strokeWidth: 8 });
    e.endStyle();
    expect(e.document.elements.map((x) => x.id)).toEqual(["first", "second"]);
    e.undo();
    expect(e.elements[0].strokeWidth).toBe(DEFAULT_STYLE.strokeWidth);
    expect(pageElements(e.document, "main")[0].id).toBe("first");
    e.redo();
    expect(e.elements[0].strokeWidth).toBe(8);
    e.switchPage("main");
    e.undo();
    expect(e.activePageId).toBe(p.id);
    expect(e.elements[0].strokeWidth).toBe(DEFAULT_STYLE.strokeWidth);
  });
  it("creates/deletes/duplicates a page in a single reversible operation and never deletes the last", () => {
    const e = new Editor();
    e.commit([shape("seed")], "Seed");
    const p = e.createPage("Проект");
    e.commit([shape("second")], "Seed second");
    e.deletePage("main");
    expect(e.pages.map((p) => p.id)).toEqual([p.id]);
    expect(() => e.deletePage(p.id)).toThrow("последнюю");
    e.undo();
    expect(e.document.elements).toHaveLength(2);
    expect(e.pages).toHaveLength(2);
    const clone = e.duplicatePage(p.id);
    expect(e.elements[0].id).not.toBe("second");
    expect(e.activePageId).toBe(clone.id);
    e.undo();
    expect(e.pages).toHaveLength(2);
    e.redo();
    expect(e.activePageId).toBe(clone.id);
    expect(e.pages).toHaveLength(3);
  });
  it("keeps personal cameras per page without changing content revision", () => {
    const e = new Editor();
    e.setCamera({ x: 123, y: 456, zoom: 0.3 });
    const p = e.createPage("Детали");
    e.setCamera({ x: -300, y: 60, zoom: 2 });
    const rev = e.document.revision;
    e.switchPage("main");
    expect(e.camera).toEqual({ x: 123, y: 456, zoom: 0.3 });
    e.switchPage(p.id);
    expect(e.camera).toEqual({ x: -300, y: 60, zoom: 2 });
    expect(e.document.revision).toBe(rev);
  });
  it("moves a whole frame, preserves incoming links and detaches bindings across page boundaries", () => {
    const e = new Editor(),
      f = {
        ...shape("frame"),
        kind: "frame" as const,
        x: 0,
        y: 0,
        width: 600,
        height: 400,
        text: "Обзор",
        fontSize: 24,
      };
    const item = shape("item"),
      outside = { ...shape("outside"), x: 1900 };
    const arrow = {
      ...shape("arrow"),
      kind: "arrow" as const,
      x: 800,
      y: 0,
      endX: -750,
      endY: 20,
      startBinding: { elementId: "outside", side: "left" as const },
      endBinding: { elementId: "item", side: "right" as const },
    };
    const link = {
      ...shape("link"),
      x: 1000,
      link: { path: "", elementId: "item" },
    };
    e.commit([f, item, outside, arrow, link], "Seed");
    const p = e.createPage("Детали");
    e.switchPage("main");
    e.transferElements(["frame"], p.id);
    expect(pageElements(e.document, p.id).map((x) => x.id)).toEqual(
      expect.arrayContaining(["frame", "item"]),
    );
    expect(
      e.elements.find((x) => x.id === "arrow")?.endBinding,
    ).toBeUndefined();
    expect(e.elements.find((x) => x.id === "link")?.link?.pageId).toBe(p.id);
    e.undo();
    expect(
      e.elements.find((x) => x.id === "arrow")?.endBinding?.elementId,
    ).toBe("item");
  });
  it("restores a whole workspace and its title as one undo without dropping pages", () => {
    const e = new Editor();
    e.commit([shape("original")], "Seed");
    const old = e.document;
    e.createPage("Другие мысли");
    e.commit([shape("new")], "Add");
    e.commitWorkspace(
      old.elements.map((x) => ({ ...x, pageId: "main" })),
      old.pages!,
      "Restore",
      "main",
      "Прежнее название",
    );
    expect(e.pages).toHaveLength(1);
    e.undo();
    expect(e.pages).toHaveLength(2);
    expect(e.document.elements.map((x) => x.id)).toEqual(["original", "new"]);
  });
  it("rejects nested, duplicate, empty or unknown pages, including previously cached objects", () => {
    const doc = {
      ...createDocument(),
      elements: [{ ...shape("x"), pageId: "main" }],
    };
    const validator = new CandidateValidator();
    validator.validate(doc);
    expect(() =>
      validator.validate({ ...doc, pages: [{ id: "other", title: "Other" }] }),
    ).toThrow();
    for (const pages of [
      [],
      [{ id: "main", title: " " }],
      [
        { id: "main", title: "One" },
        { id: "main", title: "Two" },
      ],
      [{ id: "main", title: "One", pages: [] }],
    ])
      expect(() => validateDocument({ ...doc, pages })).toThrow();
  });
  it("agent edits only the active page, can search other pages, and rejects a page switch during async validation", async () => {
    const e = new Editor();
    e.commit([shape("first")], "Seed");
    const p = e.createPage("Другой раздел");
    e.commit([shape("second")], "Seed");
    const a = new AgentController(e);
    a.enable({
      session: "pages-session",
      write: true,
      files: false,
      network: false,
    });
    await a.call("edit_batch", {
      ...ctx(a),
      operations: [{ op: "update", id: "second", patch: { x: 99 } }],
    });
    expect(pageElements(e.document, "main")[0].x).toBe(10);
    const read = (await a.call("objects_read", { pageId: "main" })) as any;
    expect(read.elements[0].id).toBe("first");
    await expect(
      a.call("edit_batch", {
        ...ctx(a),
        operations: [{ op: "update", id: "first", patch: { x: 88 } }],
      }),
    ).rejects.toThrow("NOT_FOUND");
    let release!: () => void, started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
    e.services.set("validate_assets", async () => {
      started();
      await new Promise<void>((r) => (release = r));
    });
    const args = {
      ...ctx(a),
      operations: [
        {
          op: "create",
          elements: [
            {
              kind: "math",
              id: "formula",
              x: 0,
              y: 0,
              width: 200,
              height: 100,
              text: "x^2",
            },
          ],
        },
      ],
    };
    const pending = a.call("edit_batch", args);
    await ready;
    e.switchPage("main");
    release();
    await expect(pending).rejects.toThrow("PAGE_CHANGED");
    expect(e.document.elements).toHaveLength(2);
    e.switchPage(p.id);
    const idempotent = { ...ctx(a), action: "create", title: "Ещё" };
    const result = await a.call("pages", idempotent);
    expect(await a.call("pages", idempotent)).toEqual(result);
    expect(e.pages).toHaveLength(3);
  });
});
