export type ElementKind =
  | "stroke"
  | "rectangle"
  | "ellipse"
  | "diamond"
  | "arrow"
  | "line"
  | "text"
  | "sticky"
  | "image"
  | "frame"
  | "math"
  | "table"
  | "task"
  | "link";
export interface LocalLink {
  path: string;
  elementId?: string;
  label?: string;
}
export interface TaskData {
  status: "todo" | "doing" | "done";
  due?: string;
  items: { id: string; text: string; done: boolean }[];
}
export type Binding = {
  elementId: string;
  side: "left" | "right" | "top" | "bottom";
};
export interface InkOptions {
  smoothing: number;
  stabilization: number;
  minWidth: number;
  pressure: number;
}
export type Tool =
  | "select"
  | "hand"
  | "pen"
  | "highlighter"
  | "eraser"
  | "connector"
  | "frame"
  | "math"
  | Exclude<ElementKind, "stroke" | "image">;
export type InkPoint = [x: number, y: number, pressure: number, time: number];
export interface Vec {
  x: number;
  y: number;
}
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}
export interface SceneElement {
  id: string;
  kind: ElementKind;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  fill: string;
  strokeWidth: number;
  opacity: number;
  points?: InkPoint[];
  text?: string;
  fontSize?: number;
  dataUrl?: string;
  endX?: number;
  endY?: number;
  createdAt: number;
  bold?: boolean;
  italic?: boolean;
  textAlign?: "left" | "center" | "right";
  groupId?: string;
  locked?: boolean;
  startBinding?: Binding;
  endBinding?: Binding;
  ink?: InkOptions;
  name?: string;
  hidden?: boolean;
  rotation?: number;
  connectorStyle?: "straight" | "curve" | "orthogonal";
  label?: string;
  route?: Vec[];
  cells?: string[][];
  task?: TaskData;
  link?: LocalLink;
  slideOrder?: number;
}
export interface BoardDocument {
  schemaVersion: 1 | 2 | 3;
  id: string;
  title: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  elements: SceneElement[];
}
export interface PaintStyle {
  color: string;
  fill: string;
  strokeWidth: number;
  opacity: number;
  fontSize: number;
  bold?: boolean;
  italic?: boolean;
  textAlign?: "left" | "center" | "right";
}
export interface EditingText {
  element: SceneElement;
  isNew: boolean;
  value: string;
}
export interface RenderStats {
  mainFrames: number;
  overlayFrames: number;
  lastMs: number;
  lastOverlayMs: number;
  visible: number;
  cachedPaths: number;
  inkTailPoints: number;
  samples: number[];
  overlaySamples: number[];
}

export const COLORS = [
  "#242424",
  "#0f6cbd",
  "#7f52c5",
  "#d13438",
  "#da6b12",
  "#0e7870",
] as const;
export const STICKY_COLORS = [
  "#fff1a8",
  "#fce1e9",
  "#dcd5fa",
  "#cfe9fd",
  "#d7efd9",
  "#ffe0c2",
] as const;
export const DEFAULT_STYLE: PaintStyle = {
  color: "#0f6cbd",
  fill: "transparent",
  strokeWidth: 3,
  opacity: 1,
  fontSize: 24,
};
export const uid = () => crypto.randomUUID();

export function createDocument(title = "Без названия"): BoardDocument {
  const now = new Date().toISOString();
  return {
    schemaVersion: 3,
    id: uid(),
    title,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    elements: [],
  };
}

export function createElement(
  kind: ElementKind,
  x: number,
  y: number,
  style: PaintStyle,
): SceneElement {
  return {
    id: uid(),
    kind,
    x,
    y,
    width: 0,
    height: 0,
    color: style.color,
    fill: style.fill,
    strokeWidth: style.strokeWidth,
    opacity: style.opacity,
    createdAt: Date.now(),
    ...(kind === "stroke" ? { points: [] } : {}),
    ...(kind === "text" ||
    kind === "sticky" ||
    kind === "frame" ||
    kind === "math" ||
    kind === "table" ||
    kind === "task" ||
    kind === "link"
      ? {
          text: "",
          fontSize: style.fontSize,
          bold: style.bold,
          italic: style.italic,
          textAlign: style.textAlign,
        }
      : {}),
  };
}

const kinds = new Set<ElementKind>([
  "stroke",
  "rectangle",
  "ellipse",
  "diamond",
  "arrow",
  "line",
  "text",
  "sticky",
  "image",
  "frame",
  "math",
  "table",
  "task",
  "link",
]);
const isNumber = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e9;
const isColor = (v: unknown): v is string =>
  typeof v === "string" && /^(#[0-9a-f]{6}|transparent)$/i.test(v);

export function validateDocument(value: unknown): BoardDocument {
  if (!value || typeof value !== "object")
    throw new Error("Файл не содержит доску Light Pen.");
  const doc = value as BoardDocument;
  if (![1, 2, 3].includes(doc.schemaVersion))
    throw new Error("Эта версия файла не поддерживается. Обновите Light Pen.");
  if (
    typeof doc.id !== "string" ||
    !/^[a-z\d_-]{1,128}$/i.test(doc.id) ||
    typeof doc.title !== "string" ||
    doc.title.length > 250 ||
    !Number.isSafeInteger(doc.revision) ||
    doc.revision < 0 ||
    typeof doc.createdAt !== "string" ||
    typeof doc.updatedAt !== "string" ||
    !Array.isArray(doc.elements) ||
    doc.elements.length > 100_000
  )
    throw new Error("Повреждена структура документа.");
  const ids = new Set<string>();
  let points = 0;
  for (const el of doc.elements) {
    if (
      !el ||
      typeof el !== "object" ||
      typeof el.id !== "string" ||
      !el.id ||
      ids.has(el.id) ||
      !kinds.has(el.kind) ||
      ![el.x, el.y, el.width, el.height, el.strokeWidth, el.opacity].every(
        isNumber,
      ) ||
      !Number.isFinite(el.createdAt) ||
      el.createdAt < 0 ||
      el.createdAt > 1e15 ||
      el.width < 0 ||
      el.height < 0 ||
      el.strokeWidth <= 0 ||
      el.strokeWidth > 128 ||
      el.opacity < 0 ||
      el.opacity > 1 ||
      !isColor(el.color) ||
      !isColor(el.fill)
    )
      throw new Error("В документе есть повреждённый объект.");
    ids.add(el.id);
    if (
      el.fontSize !== undefined &&
      (!isNumber(el.fontSize) || el.fontSize < 8 || el.fontSize > 256)
    )
      throw new Error("Повреждён размер текста.");
    if (
      (el.name !== undefined &&
        (typeof el.name !== "string" || el.name.length > 250)) ||
      (el.hidden !== undefined && typeof el.hidden !== "boolean") ||
      (el.rotation !== undefined &&
        (!isNumber(el.rotation) || Math.abs(el.rotation) > 360)) ||
      (el.slideOrder !== undefined &&
        (!Number.isInteger(el.slideOrder) ||
          el.slideOrder < 0 ||
          el.slideOrder > 1_000_000)) ||
      (el.connectorStyle !== undefined &&
        !["straight", "curve", "orthogonal"].includes(el.connectorStyle)) ||
      (el.label !== undefined &&
        (typeof el.label !== "string" || el.label.length > 2000)) ||
      (el.route !== undefined &&
        (!Array.isArray(el.route) ||
          el.route.length > 200 ||
          el.route.some((p) => !p || !isNumber(p.x) || !isNumber(p.y))))
    )
      throw new Error("Повреждены свойства размещения объекта.");
    if (
      el.link !== undefined &&
      (!el.link ||
        typeof el.link !== "object" ||
        typeof el.link.path !== "string" ||
        el.link.path.length > 4096 ||
        /[\x00-\x1f]/.test(el.link.path) ||
        (el.link.elementId !== undefined &&
          (typeof el.link.elementId !== "string" ||
            el.link.elementId.length > 128)) ||
        (el.link.label !== undefined &&
          (typeof el.link.label !== "string" || el.link.label.length > 250)))
    )
      throw new Error("Повреждена локальная ссылка.");
    if (
      el.kind === "table" &&
      (!Array.isArray(el.cells) ||
        !el.cells.length ||
        el.cells.length > 100 ||
        !el.cells[0]?.length ||
        el.cells[0].length > 50 ||
        el.cells.some(
          (row) =>
            !Array.isArray(row) ||
            row.length !== el.cells![0].length ||
            row.some((c) => typeof c !== "string" || c.length > 10000),
        ))
    )
      throw new Error("Повреждена таблица (до 100 строк и 50 столбцов).");
    if (
      el.kind === "task" &&
      (!el.task ||
        !["todo", "doing", "done"].includes(el.task.status) ||
        (el.task.due !== undefined &&
          !/^\d{4}-\d{2}-\d{2}$/.test(el.task.due)) ||
        !Array.isArray(el.task.items) ||
        el.task.items.length > 100 ||
        new Set(el.task.items.map((i) => i?.id)).size !==
          el.task.items.length ||
        el.task.items.some(
          (i) =>
            !i ||
            typeof i.id !== "string" ||
            !i.id ||
            typeof i.text !== "string" ||
            i.text.length > 10000 ||
            typeof i.done !== "boolean",
        ))
    )
      throw new Error("Повреждена карточка задачи.");
    if (el.kind === "link" && !el.link)
      throw new Error("У ссылки нет назначения.");
    if (
      (el.bold !== undefined && typeof el.bold !== "boolean") ||
      (el.italic !== undefined && typeof el.italic !== "boolean") ||
      (el.locked !== undefined && typeof el.locked !== "boolean") ||
      (el.groupId !== undefined &&
        (typeof el.groupId !== "string" ||
          !/^[a-z\d_-]{1,128}$/i.test(el.groupId))) ||
      (el.textAlign !== undefined &&
        !["left", "center", "right"].includes(el.textAlign))
    )
      throw new Error("Повреждены дополнительные свойства объекта.");
    for (const binding of [el.startBinding, el.endBinding])
      if (
        binding !== undefined &&
        (el.kind !== "arrow" ||
          !binding ||
          typeof binding.elementId !== "string" ||
          !binding.elementId ||
          !["left", "right", "top", "bottom"].includes(binding.side))
      )
        throw new Error("Повреждена привязка стрелки.");
    if (
      el.ink &&
      (![
        el.ink.smoothing,
        el.ink.stabilization,
        el.ink.minWidth,
        el.ink.pressure,
      ].every(isNumber) ||
        el.ink.smoothing < 0 ||
        el.ink.smoothing > 100 ||
        el.ink.stabilization < 0 ||
        el.ink.stabilization > 95 ||
        el.ink.minWidth < 1 ||
        el.ink.minWidth > 100 ||
        el.ink.pressure < 25 ||
        el.ink.pressure > 200)
    )
      throw new Error("Повреждены настройки пера.");
    if (el.kind === "stroke") {
      if (
        !Array.isArray(el.points) ||
        el.points.length === 0 ||
        el.points.some(
          (p) =>
            !Array.isArray(p) ||
            p.length !== 4 ||
            !p.every(isNumber) ||
            p[2] < 0 ||
            p[2] > 1 ||
            p[3] < 0,
        )
      )
        throw new Error("Повреждены точки штриха.");
      points += el.points.length;
      if (points > 2_000_000)
        throw new Error("В документе слишком много точек.");
    }
    if (
      ["text", "sticky", "math", "frame", "table", "task", "link"].includes(
        el.kind,
      )
    ) {
      if (
        typeof el.text !== "string" ||
        el.text.length > 100_000 ||
        !isNumber(el.fontSize) ||
        el.fontSize < 8 ||
        el.fontSize > 256
      )
        throw new Error("Повреждён текст объекта.");
    }
    if (el.kind === "arrow" || el.kind === "line") {
      if (!isNumber(el.endX) || !isNumber(el.endY))
        throw new Error("Повреждена линия.");
    }
    if (
      el.kind === "image" &&
      (typeof el.dataUrl !== "string" ||
        !/^data:image\/(png|jpeg|webp);base64,[a-z\d+/=]+$/i.test(el.dataUrl))
    )
      throw new Error("Неподдерживаемое изображение.");
  }
  return doc;
}
