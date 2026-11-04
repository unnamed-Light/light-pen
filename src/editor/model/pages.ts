import type { BoardDocument, SceneElement } from "./types";
import { resolveBindings } from "./relations";
import { pagesOf, MAIN_PAGE } from "./types";
export { pagesOf, MAIN_PAGE } from "./types";
export function elementPage(doc: BoardDocument, el: SceneElement): string {
  return el.pageId ?? pagesOf(doc)[0].id;
}
export function pageElements(
  doc: BoardDocument,
  pageId: string,
): SceneElement[] {
  if (!pagesOf(doc).some((p) => p.id === pageId))
    throw Error("Страница не найдена.");
  if (pagesOf(doc).length === 1) return doc.elements;
  return doc.elements.filter((e) => elementPage(doc, e) === pageId);
}
export function resolveWorkspaceBindings(
  elements: SceneElement[],
  defaultId = MAIN_PAGE,
): SceneElement[] {
  if (
    !elements.some(
      (e) =>
        e.startBinding || e.endBinding || e.connectorStyle === "orthogonal",
    )
  )
    return elements;
  const groups = new Map<string, SceneElement[]>();
  for (const e of elements) {
    const id = e.pageId ?? defaultId;
    let group = groups.get(id);
    if (!group) groups.set(id, (group = []));
    group.push(e);
  }
  if (groups.size === 1) return resolveBindings(elements);
  const resolved = new Map<string, SceneElement>();
  for (const group of groups.values())
    for (const e of resolveBindings(group)) resolved.set(e.id, e);
  return elements.map((e) => resolved.get(e.id)!);
}
/** A detached, single-page document for renderers and portable fragments. */
export function pageDocument(
  doc: BoardDocument,
  pageId: string,
): BoardDocument {
  const page = pagesOf(doc).find((p) => p.id === pageId);
  if (!page) throw Error("Страница не найдена.");
  return {
    ...doc,
    schemaVersion: 5,
    title: page.title,
    pages: [page],
    elements: pageElements(doc, pageId),
  };
}
export function replacePageElements(
  doc: BoardDocument,
  pageId: string,
  elements: SceneElement[],
): SceneElement[] {
  if (pagesOf(doc).length === 1)
    return elements.map((e) =>
      e.pageId === undefined || e.pageId === pageId ? e : { ...e, pageId },
    );
  const normalized = elements.map((e) =>
    e.pageId === pageId ? e : { ...e, pageId },
  );
  const out: SceneElement[] = [];
  let inserted = false;
  for (const e of doc.elements) {
    if (elementPage(doc, e) === pageId) {
      if (!inserted) {
        out.push(...normalized);
        inserted = true;
      }
    } else out.push(e);
  }
  if (!inserted) out.push(...normalized);
  return out;
}
