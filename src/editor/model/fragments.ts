import { createDocument, uid, validateDocument } from "./types";
import type { BoardDocument, SceneElement, Vec } from "./types";
import {
  bounds,
  contains,
  rotatePoint,
  rotationCenter,
  translateElement,
  unionBounds,
} from "./geometry";
import { elementPage } from "./pages";

export const FRAGMENT_PREFIX = "application/vnd.lightpen.fragment+json\n";
export const MAX_FRAGMENT_BYTES = 64 * 1024 * 1024;
export interface FragmentWarning {
  kind: "binding" | "link" | "dependency";
  elementId: string;
  target?: string;
  message: string;
}
export interface PortableFragment {
  format: "lightpen-fragment";
  version: 1;
  title: string;
  createdAt: string;
  source: { documentId: string; pageId: string };
  elements: SceneElement[];
  warnings: FragmentWarning[];
}

function insideFrame(element: SceneElement, frame: SceneElement) {
  const b = bounds(element),
    center = rotationCenter(frame);
  const area = {
    minX: frame.x,
    minY: frame.y,
    maxX: frame.x + frame.width,
    maxY: frame.y + frame.height,
  };
  return [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ].every((p) =>
    contains(area, rotatePoint(p, center, -(frame.rotation ?? 0)), 0.01),
  );
}

export function fragmentWarnings(
  elements: SceneElement[],
  sourcePageId: string,
): FragmentWarning[] {
  const ids = new Set(elements.map((e) => e.id));
  const warnings: FragmentWarning[] = [];
  for (const e of elements) {
    for (const b of [e.startBinding, e.endBinding])
      if (b && !ids.has(b.elementId))
        warnings.push({
          kind: "binding",
          elementId: e.id,
          target: b.elementId,
          message: "Привязка к объекту вне фрагмента будет отсоединена.",
        });
    if (e.link) {
      if (e.link.path)
        warnings.push({
          kind: "link",
          elementId: e.id,
          target: e.link.path,
          message:
            "Ссылка на внешний файл сохранится; файл не входит во фрагмент.",
        });
      else if (
        (e.link.elementId && !ids.has(e.link.elementId)) ||
        (e.link.pageId && e.link.pageId !== sourcePageId && !e.link.elementId)
      )
        warnings.push({
          kind: "link",
          elementId: e.id,
          target: e.link.elementId ?? e.link.pageId,
          message:
            "Назначение ссылки вне фрагмента не переносится. Ссылку потребуется задать заново.",
        });
    }
    for (const id of e.task?.dependencies ?? [])
      if (!ids.has(id))
        warnings.push({
          kind: "dependency",
          elementId: e.id,
          target: id,
          message: "Зависимость от задачи вне фрагмента не переносится.",
        });
  }
  return warnings;
}

/** Expand selected frames before the user reviews the final export composition. */
export function buildFragment(
  document: BoardDocument,
  selectedIds: readonly string[],
  options: {
    includeFrameContents?: boolean;
    pageId?: string;
    title?: string;
  } = {},
): PortableFragment {
  const selected = new Set(selectedIds);
  if (!selected.size) throw Error("Выделите объекты или фрейм для переноса.");
  const found = document.elements.filter((e) => selected.has(e.id));
  if (found.length !== selected.size)
    throw Error("Один из объектов фрагмента больше не существует.");
  const pageId = options.pageId ?? elementPage(document, found[0]);
  if (found.some((e) => elementPage(document, e) !== pageId))
    throw Error("Соберите фрагмент из объектов одной страницы.");
  if (options.includeFrameContents !== false) {
    const frames = found.filter((e) => e.kind === "frame");
    if (frames.length)
      for (const e of document.elements)
        if (
          !selected.has(e.id) &&
          elementPage(document, e) === pageId &&
          frames.some((f) => insideFrame(e, f))
        )
          selected.add(e.id);
  }
  return validateFragment({
    format: "lightpen-fragment",
    version: 1,
    title: (options.title ?? document.title).trim().slice(0, 250) || "Фрагмент",
    createdAt: new Date().toISOString(),
    source: { documentId: document.id, pageId },
    elements: structuredClone(
      document.elements.filter((e) => selected.has(e.id)),
    ),
    warnings: [],
  });
}

export function validateFragment(value: unknown): PortableFragment {
  if (!value || typeof value !== "object")
    throw Error("Файл не содержит фрагмент Light Pen.");
  const fragment = value as PortableFragment;
  if (fragment.format !== "lightpen-fragment" || fragment.version !== 1)
    throw Error("Версия фрагмента не поддерживается.");
  if (
    typeof fragment.title !== "string" ||
    fragment.title.length > 250 ||
    typeof fragment.createdAt !== "string" ||
    Number.isNaN(Date.parse(fragment.createdAt)) ||
    !fragment.source ||
    typeof fragment.source.documentId !== "string" ||
    !fragment.source.documentId ||
    fragment.source.documentId.length > 128 ||
    typeof fragment.source.pageId !== "string" ||
    !/^[a-z\d_-]{1,128}$/i.test(fragment.source.pageId) ||
    !Array.isArray(fragment.elements) ||
    !fragment.elements.length
  )
    throw Error("Повреждена структура фрагмента.");
  const pages = new Set([
    fragment.source.pageId,
    ...fragment.elements
      .map((e) => e?.pageId)
      .filter((id): id is string => typeof id === "string"),
  ]);
  const doc = validateDocument({
    ...createDocument(fragment.title),
    pages: [...pages].map((id) => ({ id, title: "Страница" })),
    elements: fragment.elements,
  });
  if (
    new TextEncoder().encode(JSON.stringify(fragment)).length >
    MAX_FRAGMENT_BYTES
  )
    throw Error("Фрагмент превышает 64 МБ.");
  return {
    format: "lightpen-fragment",
    version: 1,
    title: fragment.title,
    createdAt: fragment.createdAt,
    source: {
      documentId: fragment.source.documentId,
      pageId: fragment.source.pageId,
    },
    elements: doc.elements,
    warnings: fragmentWarnings(doc.elements, fragment.source.pageId),
  };
}

export function parseFragment(text: string): PortableFragment {
  if (new TextEncoder().encode(text).length > MAX_FRAGMENT_BYTES)
    throw Error("Фрагмент превышает 64 МБ.");
  const source = text.startsWith(FRAGMENT_PREFIX)
    ? text.slice(FRAGMENT_PREFIX.length)
    : text;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw Error("Файл фрагмента содержит повреждённый JSON.");
  }
  return validateFragment(value);
}

/** All identities belong to the new copy; unresolved internal references cannot attach by accident. */
export function importFragmentElements(
  value: PortableFragment,
  options: { pageId: string; at?: Vec; slideOrderStart?: number },
) {
  const fragment = validateFragment(value);
  if (!/^[a-z\d_-]{1,128}$/i.test(options.pageId))
    throw Error("Страница назначения не найдена.");
  if (options.at && !Number.isFinite(options.at.x + options.at.y))
    throw Error("Некорректная позиция фрагмента.");
  const ids = new Map(fragment.elements.map((e) => [e.id, uid()]));
  const groups = new Map<string, string>();
  for (const e of fragment.elements)
    for (const id of e.groupPath ?? (e.groupId ? [e.groupId] : []))
      if (!groups.has(id)) groups.set(id, uid());
  const b = unionBounds(fragment.elements)!;
  const dx = options.at ? options.at.x - (b.minX + b.maxX) / 2 : 0;
  const dy = options.at ? options.at.y - (b.minY + b.maxY) / 2 : 0;
  const orderedFrames = fragment.elements
    .filter((e) => e.kind === "frame")
    .sort(
      (a, b) => (a.slideOrder ?? a.createdAt) - (b.slideOrder ?? b.createdAt),
    );
  const slideOrder = new Map(
    orderedFrames.map((e, i) => [e.id, (options.slideOrderStart ?? 0) + i]),
  );
  const elements = structuredClone(fragment.elements).map((original) => {
    const e = translateElement(original, dx, dy);
    const link = e.link;
    if (link && !link.path) {
      if (link.elementId && ids.has(link.elementId))
        e.link = {
          ...link,
          pageId: options.pageId,
          elementId: ids.get(link.elementId),
        };
      else if (
        !link.elementId &&
        (!link.pageId || link.pageId === fragment.source.pageId)
      )
        e.link = { ...link, pageId: options.pageId };
      else
        e.link =
          e.kind === "link" ? { path: "", label: link.label } : undefined;
    }
    e.id = ids.get(original.id)!;
    e.pageId = options.pageId;
    e.createdAt = Date.now();
    e.groupId = e.groupId ? groups.get(e.groupId) : undefined;
    e.groupPath = e.groupPath?.map((id) => groups.get(id)!);
    e.startBinding =
      e.startBinding && ids.has(e.startBinding.elementId)
        ? { ...e.startBinding, elementId: ids.get(e.startBinding.elementId)! }
        : undefined;
    e.endBinding =
      e.endBinding && ids.has(e.endBinding.elementId)
        ? { ...e.endBinding, elementId: ids.get(e.endBinding.elementId)! }
        : undefined;
    if (e.grid)
      e.grid = {
        rows: e.grid.rows.map(() => uid()),
        columns: e.grid.columns.map((column) => ({ ...column, id: uid() })),
      };
    if (e.task)
      e.task = {
        ...e.task,
        items: e.task.items.map((item) => ({ ...item, id: uid() })),
        dependencies: e.task.dependencies
          ?.filter((id) => ids.has(id))
          .map((id) => ids.get(id)!),
      };
    if (e.kind === "frame") e.slideOrder = slideOrder.get(original.id);
    return e;
  });
  // Check before returning a candidate so callers can commit once, with no partial import.
  validateDocument({
    ...createDocument(),
    pages: [{ id: options.pageId, title: "Страница" }],
    elements,
  });
  return { elements, warnings: fragment.warnings, source: fragment.source };
}
