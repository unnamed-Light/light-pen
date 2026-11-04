import * as Y from "yjs";
import { validateDocument, pagesOf } from "../editor/model/types";
import type { BoardDocument, SceneElement } from "../editor/model/types";
import {
  updateText,
  seedGrid,
  patchGrid,
  readGrid,
  seedTask,
  patchTask,
  readTask,
} from "./structured";

export const LOCAL = Symbol("local-editor");
export const REMOTE = Symbol("remote-editor");
const equal = (a: unknown, b: unknown) =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

export class SharedBoard {
  readonly doc: Y.Doc;
  readonly meta: Y.Map<unknown>;
  readonly elements: Y.Map<Y.Map<unknown>>;
  readonly pages: Y.Map<Y.Map<unknown>>;
  private cached = new Map<
    string,
    { map: Y.Map<unknown>; order: number; element: SceneElement; bytes: number }
  >();
  private dirty = new Set<string>();
  private known = new WeakMap<BoardDocument, number>();
  /** Exact UTF-8 JSON size of the most recent successful immutable snapshot. */
  jsonBytes = 0;
  constructor(doc = new Y.Doc()) {
    this.doc = doc;
    this.meta = doc.getMap("board");
    this.elements = doc.getMap("elements");
    this.pages = doc.getMap("pages");
    this.elements.observeDeep((events) => {
      for (const event of events) {
        if (event.path.length) this.dirty.add(String(event.path[0]));
        else if (event instanceof Y.YMapEvent)
          for (const key of event.keysChanged) this.dirty.add(key);
      }
    });
  }
  seed(document: BoardDocument) {
    if (this.meta.size || this.elements.size)
      throw new Error("Общая доска уже инициализирована.");
    validateDocument(document);
    this.doc.transact(() => {
      for (const key of ["id", "title", "createdAt"] as const)
        this.meta.set(key, document[key]);
      for (const [index, page] of pagesOf(document).entries()) {
        const map = new Y.Map<unknown>();
        this.pages.set(page.id, map);
        map.set("title", page.title);
        map.set("_order", index);
      }
      for (const [index, element] of document.elements.entries())
        this.add(
          element.pageId
            ? element
            : { ...element, pageId: pagesOf(document)[0].id },
          index,
        );
    }, "seed");
  }
  private add(element: SceneElement, order: number) {
    const map = new Y.Map<unknown>();
    this.elements.set(element.id, map);
    for (const [key, value] of Object.entries(element)) {
      if (value === undefined) continue;
      if (element.kind === "table" && ["cells", "grid"].includes(key)) continue;
      if (element.kind === "task" && key === "task") continue;
      if (key === "text") {
        const text = new Y.Text();
        map.set(key, text);
        text.insert(0, String(value));
      } else map.set(key, structuredClone(value));
    }
    if (element.kind === "table") seedGrid(map, element);
    if (element.kind === "task") seedTask(map, element.task!);
    map.set("_order", order);
  }
  patch(before: BoardDocument, after: BoardDocument) {
    if (before.id !== after.id || this.meta.get("id") !== after.id)
      throw new Error("Нельзя заменить другую общую доску.");
    const actions: {
      element: SceneElement;
      previous: SceneElement | undefined;
      index: number;
      oldIndex: number | undefined;
    }[] = [];
    const changed: SceneElement[] = [],
      removed: string[] = [];
    const knownPoints = this.known.get(before);
    const sameOrder =
      knownPoints !== undefined &&
      before.elements.length === after.elements.length &&
      after.elements.every((e, i) => e.id === before.elements[i].id);
    let points = knownPoints ?? 0;
    if (sameOrder) {
      for (let index = 0; index < after.elements.length; index++) {
        const element = after.elements[index],
          previous = before.elements[index];
        if (element === previous) continue;
        changed.push(element);
        actions.push({ element, previous, index, oldIndex: index });
        points +=
          (element.kind === "stroke" ? (element.points?.length ?? 0) : 0) -
          (previous.kind === "stroke" ? (previous.points?.length ?? 0) : 0);
      }
    } else {
      points = 0;
      const old = new Map(before.elements.map((e, i) => [e.id, i])),
        current = new Set<string>();
      for (let index = 0; index < after.elements.length; index++) {
        const element = after.elements[index],
          oldIndex = old.get(element.id),
          previous =
            oldIndex === undefined ? undefined : before.elements[oldIndex];
        current.add(element.id);
        if (element.kind === "stroke") points += element.points?.length ?? 0;
        if (previous !== element) changed.push(element);
        if (previous !== element || oldIndex !== index)
          actions.push({ element, previous, index, oldIndex });
      }
      if (current.size !== after.elements.length)
        throw new Error("Повторяющиеся объекты.");
      for (const id of old.keys()) if (!current.has(id)) removed.push(id);
    }
    if (after.elements.length > 100_000 || points > 2_000_000)
      throw new Error("Повторяющиеся объекты или превышен размер документа.");
    // Local models are immutable. Validate new/changed objects without scanning the
    // geometry of every unchanged stroke; the authoritative server validates all.
    validateDocument({ ...after, elements: changed });
    if (
      actions.some(
        ({ element, previous }) => previous && element.kind !== previous.kind,
      )
    )
      throw new Error(
        "Преобразование типа объекта общей доски пока не поддерживается.",
      );
    this.doc.transact(() => {
      if (before.title !== after.title) this.meta.set("title", after.title);
      const oldPages = new Map(
          pagesOf(before).map((p, i) => [p.id, { page: p, index: i }]),
        ),
        nextPages = pagesOf(after),
        nextIds = new Set(nextPages.map((p) => p.id));
      for (const id of oldPages.keys())
        if (!nextIds.has(id)) this.pages.delete(id);
      for (const [index, page] of nextPages.entries()) {
        const previous = oldPages.get(page.id);
        let map = this.pages.get(page.id);
        if (!previous) {
          if (map) continue;
          map = new Y.Map<unknown>();
          this.pages.set(page.id, map);
          map.set("title", page.title);
          map.set("_order", index);
        } else if (map) {
          if (previous.page.title !== page.title) map.set("title", page.title);
          if (previous.index !== index) map.set("_order", index);
        }
      }
      for (const id of removed) this.elements.delete(id);
      for (const { index, element, previous, oldIndex } of actions) {
        const map = this.elements.get(element.id);
        if (!previous) {
          if (!map) this.add(element, index);
          continue;
        }
        // A concurrent deletion wins over an edit; an old client cannot resurrect it.
        if (!map) continue;
        if (oldIndex !== index) map.set("_order", index);
        if (previous === element) continue;
        if (
          element.kind === "table" &&
          (!equal(previous.cells, element.cells) ||
            !equal(previous.grid, element.grid))
        ) {
          if (!map.has("_grid"))
            seedGrid(map, { ...previous, ...readGrid(map) });
          patchGrid(map, previous, element);
          map.delete("cells");
          map.delete("grid");
        }
        if (element.kind === "task" && !equal(previous.task, element.task)) {
          if (!(map.get("task") instanceof Y.Map))
            seedTask(map, previous.task!);
          patchTask(map, previous.task, element.task!);
        }
        for (const key of new Set([
          ...Object.keys(previous),
          ...Object.keys(element),
        ])) {
          if (element.kind === "table" && ["cells", "grid"].includes(key))
            continue;
          if (element.kind === "task" && key === "task") continue;
          const a = previous[key as keyof SceneElement],
            b = element[key as keyof SceneElement];
          if (equal(a, b)) continue;
          if (b === undefined) {
            map.delete(key);
            continue;
          }
          if (key === "text" && map.get(key) instanceof Y.Text)
            updateText(map.get(key) as Y.Text, String(a ?? ""), String(b));
          else map.set(key, structuredClone(b));
        }
      }
    }, LOCAL);
    this.known.set(after, points);
  }
  snapshot(revision = 0): BoardDocument {
    const changed: SceneElement[] = [];
    let bytes = 0,
      points = 0;
    const ordered = [...this.elements.entries()]
      .map(([id, map]) => {
        if (!(map instanceof Y.Map)) throw new Error("Повреждён общий объект.");
        const cached = this.cached.get(id);
        if (cached && cached.map === map && !this.dirty.has(id)) {
          bytes += cached.bytes;
          points +=
            cached.element.kind === "stroke"
              ? (cached.element.points?.length ?? 0)
              : 0;
          return { order: cached.order, element: cached.element };
        }
        const { _order, _grid, ...data } = map.toJSON();
        if (data.kind === "table") Object.assign(data, readGrid(map));
        if (data.kind === "task") data.task = readTask(map);
        if (data.id !== id || !Number.isFinite(_order))
          throw new Error("Повреждён порядок объектов.");
        const element = data as SceneElement;
        this.dirty.add(id); // Failed validation must never promote a cached candidate.
        changed.push(element);
        const size = new TextEncoder().encode(JSON.stringify(element)).length;
        bytes += size;
        points += element.kind === "stroke" ? (element.points?.length ?? 0) : 0;
        this.cached.set(id, {
          map,
          order: Number(_order),
          element,
          bytes: size,
        });
        return { order: Number(_order), element };
      })
      .sort(
        (a, b) => a.order - b.order || a.element.id.localeCompare(b.element.id),
      );
    if (ordered.length > 100_000 || points > 2_000_000)
      throw new Error("Превышен размер общей доски.");
    const pageEntries = [...this.pages.entries()]
      .map(([id, map]) => {
        if (!(map instanceof Y.Map) || !Number.isFinite(map.get("_order")))
          throw Error("Повреждён порядок страниц.");
        return {
          id,
          title: map.get("title") as string,
          order: Number(map.get("_order")),
        };
      })
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    // Two peers can concurrently delete different last pages. Recover a stable
    // landing page and retain late objects rather than losing concurrent work.
    const pages = pageEntries.length
      ? pageEntries.map(({ id, title }) => ({ id, title }))
      : [{ id: "main", title: "Страница 1" }];
    const pageIds = new Set(pages.map((p) => p.id));
    const document: BoardDocument = {
      schemaVersion: 5,
      pages,
      id: this.meta.get("id"),
      title: this.meta.get("title"),
      createdAt: this.meta.get("createdAt"),
      updatedAt: new Date().toISOString(),
      revision,
      elements: ordered.map(({ element }) => {
        if (element.pageId && pageIds.has(element.pageId)) return element;
        const normalized = { ...element, pageId: pages[0].id };
        bytes +=
          new TextEncoder().encode(JSON.stringify(normalized)).length -
          new TextEncoder().encode(JSON.stringify(element)).length;
        changed.push(normalized);
        return normalized;
      }),
    } as BoardDocument;
    const changedIds = new Set(changed.map((e) => e.id));
    validateDocument({
      ...document,
      elements: document.elements.filter((e) => changedIds.has(e.id)),
    });
    for (const id of this.cached.keys())
      if (!this.elements.has(id)) this.cached.delete(id);
    this.dirty.clear();
    this.jsonBytes =
      new TextEncoder().encode(JSON.stringify({ ...document, elements: [] }))
        .length +
      bytes +
      Math.max(0, ordered.length - 1);
    this.known.set(document, points);
    return document;
  }
  encode(vector?: Uint8Array) {
    return Y.encodeStateAsUpdate(this.doc, vector);
  }
  apply(update: Uint8Array) {
    Y.applyUpdate(this.doc, update, REMOTE);
  }
  destroy() {
    this.cached.clear();
    this.dirty.clear();
    this.doc.destroy();
  }
}
