import { History } from "./commands/history";
import { bindingAt, copyElements, resolveBindings } from "./model/relations";
import {
  bounds,
  clamp,
  contains,
  expand,
  hitTest,
  intersects,
  rectFromPoints,
  resizeElement,
  screenToWorld,
  sweepHitTest,
  translateElement,
  unionBounds,
  rotateElements,
  rotatePoint,
  rotationCenter,
  zoomAt,
} from "./model/geometry";
import {
  createDocument,
  createElement,
  DEFAULT_STYLE,
  uid,
  validateDocument,
} from "./model/types";
import type {
  BoardDocument,
  Bounds,
  Camera,
  EditingText,
  InkPoint,
  PaintStyle,
  SceneElement,
  Tool,
  Vec,
  InkOptions,
} from "./model/types";

export type Signal = "ui" | "overlay" | "scene" | "camera" | "document";
type PointerSample = Vec & {
  pressure: number;
  pointerType: string;
  time: number;
};
type Gesture =
  | {
      type: "rotate";
      pointer: number;
      center: Vec;
      startAngle: number;
      original: SceneElement[];
      preview: SceneElement[];
      moved: boolean;
    }
  | { type: "endpoint"; element: SceneElement; pointer: number; start: boolean }
  | { type: "ink"; element: SceneElement; pointer: number; startTime: number }
  | { type: "shape"; element: SceneElement; pointer: number; start: Vec }
  | { type: "pan"; pointer: number; start: Vec; camera: Camera }
  | {
      type: "move";
      pointer: number;
      start: Vec;
      original: SceneElement[];
      preview: SceneElement[];
      moved: boolean;
    }
  | {
      type: "resize";
      pointer: number;
      start: Vec;
      handle: number;
      from: Bounds;
      original: SceneElement[];
      preview: SceneElement[];
      moved: boolean;
    }
  | {
      type: "marquee";
      pointer: number;
      start: Vec;
      end: Vec;
      previous: Set<string>;
    }
  | { type: "erase"; pointer: number; erased: Set<string>; last: Vec };
export interface Replay {
  progress: number;
  playing: boolean;
  speed: number;
  duration: number;
  lastTime: number;
}

export class Editor {
  document: BoardDocument = createDocument();
  camera: Camera = { x: 0, y: 0, zoom: 1 };
  tool: Tool = "pen";
  style: PaintStyle = { ...DEFAULT_STYLE };
  selected = new Set<string>();
  history = new History();
  gesture: Gesture | null = null;
  editing: EditingText | null = null;
  replay: Replay | null = null;
  spaceHeld = false;
  grid = true;
  enabled = true;
  contextMenu: Vec | null = null;
  formulaDraft: SceneElement | null = null;
  objectDraft: SceneElement | null = null;
  objectDraftMode: "content" | "link" = "content";
  templateRequested = false;
  linkRequest: SceneElement["link"] | null = null;
  dock:
    | "properties"
    | "objects"
    | "insert"
    | "templates"
    | "search"
    | "frames"
    | null = "properties";
  eraserSize = 20;
  markerSize = 24;
  connectorStyle: NonNullable<SceneElement["connectorStyle"]> = "straight";
  presenting = false;
  presentationFrame: string | null = null;
  pen: InkOptions = {
    smoothing: 60,
    stabilization: 12,
    minWidth: 40,
    pressure: 100,
  };
  snap = true;
  guides: { axis: "x" | "y"; value: number }[] = [];
  private styleBefore: SceneElement[] | null = null;
  measureTextLines:
    | ((
        text: string,
        fontSize: number,
        width: number,
        style?: SceneElement,
      ) => number)
    | null = null;
  viewport = { width: 1200, height: 800 };
  pointer: Vec | null = null;
  private listeners = new Set<(signal: Signal) => void>();
  private clipboard: SceneElement[] = [];
  private uiVersion = 0;
  private lastReplayUi = 0;
  subscribe = (fn: (signal: Signal) => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  subscribeUi = (fn: () => void) =>
    this.subscribe((s) => {
      if (s !== "overlay") fn();
    });
  getSnapshot = () => this.uiVersion;
  emit(signal: Signal) {
    if (signal !== "overlay") this.uiVersion++;
    for (const fn of this.listeners) fn(signal);
  }
  get elements() {
    return this.document.elements;
  }
  get selection() {
    return this.elements.filter((e) => this.selected.has(e.id));
  }
  get isInteracting() {
    return (
      this.gesture !== null ||
      this.editing !== null ||
      this.styleBefore !== null
    );
  }
  get previewElements(): SceneElement[] {
    const g = this.gesture;
    if (g?.type === "move" || g?.type === "resize" || g?.type === "rotate")
      return g.moved ? this.relatedPreview(g.preview) : [];
    if (g?.type === "shape") return [g.element];
    if (g?.type === "endpoint") return [g.element];
    return [];
  }
  get hiddenIds(): Set<string> {
    const g = this.gesture;
    if (g?.type === "erase") return g.erased;
    if (g?.type === "endpoint") return new Set([g.element.id]);
    if (
      (g?.type === "move" || g?.type === "resize" || g?.type === "rotate") &&
      g.moved
    )
      return new Set(this.relatedPreview(g.preview).map((e) => e.id));
    if (this.editing && !this.editing.isNew)
      return new Set([this.editing.element.id]);
    return new Set();
  }
  get selectionBounds() {
    return unionBounds(
      this.previewElements.length
        ? this.previewElements.filter((e) => this.selected.has(e.id))
        : this.selection,
    );
  }

  setDocument(doc: BoardDocument) {
    validateDocument(doc);
    this.cancelGesture();
    this.editing = null;
    this.styleBefore = null;
    this.contextMenu = null;
    this.formulaDraft = null;
    this.objectDraft = null;
    this.linkRequest = null;
    this.presenting = false;
    this.presentationFrame = null;
    this.replay = null;
    this.document = { ...doc, elements: resolveBindings(doc.elements) };
    this.history.clear();
    this.selected.clear();
    this.camera = { x: 0, y: 0, zoom: 1 };
    this.emit("scene");
    this.fit();
  }
  private changed(elements: SceneElement[], title = this.document.title) {
    this.document = {
      ...this.document,
      schemaVersion: 3,
      title,
      elements: resolveBindings(elements),
      revision: this.document.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    const ids = new Set(elements.map((e) => e.id));
    this.selected = new Set([...this.selected].filter((id) => ids.has(id)));
    this.emit("document");
  }
  commit(elements: SceneElement[], label: string, title?: string) {
    this.endStyle();
    this.history.push(
      this.elements,
      elements,
      label,
      title === undefined ? undefined : this.document.title,
      title,
    );
    this.changed(elements, title);
  }
  rename(title: string) {
    const clean = title.trim().slice(0, 250) || "Без названия";
    if (clean !== this.document.title) {
      this.document = {
        ...this.document,
        title: clean,
        revision: this.document.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      this.emit("document");
    }
  }
  undo() {
    this.endStyle();
    this.commitText();
    this.cancelGesture();
    const e = this.history.undo();
    if (e) this.changed(e, this.history.restoredTitle);
  }
  redo() {
    this.endStyle();
    this.commitText();
    this.cancelGesture();
    const e = this.history.redo();
    if (e) this.changed(e, this.history.restoredTitle);
  }
  setTool(tool: Tool) {
    this.endStyle();
    this.commitText();
    this.cancelGesture();
    this.stopReplay();
    this.tool = tool;
    this.dock = "properties";
    if (tool !== "select") this.selected.clear();
    this.emit("ui");
  }
  setStyle(patch: Partial<PaintStyle>, apply = true) {
    this.style = { ...this.style, ...patch };
    if (apply && this.selected.size) {
      const els = this.elements.map((e) =>
        this.selected.has(e.id) && !e.locked ? this.styledElement(e, patch) : e,
      );
      if (!els.some((e, i) => e !== this.elements[i])) {
        this.emit("ui");
        return;
      }
      if (this.styleBefore) {
        this.document = { ...this.document, elements: resolveBindings(els) };
        this.emit("scene");
      } else if (els.some((e, i) => e !== this.elements[i]))
        this.commit(els, "Свойства");
    } else this.emit("ui");
  }
  deleteSelection() {
    if (!this.selected.size) return;
    this.commit(
      this.elements.filter((e) => e.locked || !this.selected.has(e.id)),
      "Удаление",
    );
  }
  duplicate() {
    if (!this.selected.size) return;
    const copies = copyElements(this.selection, 24, 24);
    this.selected = new Set(copies.map((e) => e.id));
    this.commit([...this.elements, ...copies], "Дублирование");
  }
  copy() {
    this.clipboard = this.selection.map((e) => ({ ...e }));
  }
  paste() {
    if (!this.clipboard.length) return;
    const copies = copyElements(this.clipboard, 24, 24);
    this.clipboard = copies;
    this.selected = new Set(copies.map((e) => e.id));
    this.commit([...this.elements, ...copies], "Вставка");
    this.tool = "select";
    this.emit("ui");
  }
  selectAll() {
    this.selected = new Set(
      this.elements.filter((e) => !e.locked && !e.hidden).map((e) => e.id),
    );
    this.emit("ui");
    this.emit("overlay");
  }
  arrange(direction: "front" | "back") {
    if (!this.selected.size) return;
    const picked = this.selection.filter((e) => !e.locked),
      ids = new Set(picked.map((e) => e.id)),
      rest = this.elements.filter((e) => !ids.has(e.id));
    if (!picked.length) return;
    this.commit(
      direction === "front" ? [...rest, ...picked] : [...picked, ...rest],
      "Порядок объектов",
    );
  }
  private styledElement(
    e: SceneElement,
    patch: Partial<PaintStyle>,
  ): SceneElement {
    const textKind = [
      "text",
      "sticky",
      "frame",
      "math",
      "table",
      "task",
      "link",
      "arrow",
      "line",
    ].includes(e.kind);
    const clean = { ...patch };
    if (!textKind) {
      delete clean.fontSize;
      delete clean.bold;
      delete clean.italic;
      delete clean.textAlign;
    }
    if (
      Object.entries(clean).every(([k, v]) => e[k as keyof SceneElement] === v)
    )
      return e;
    let next = { ...e, ...clean };
    if (patch.fontSize && e.kind === "math") {
      const scale = patch.fontSize / (e.fontSize ?? 24);
      next = { ...next, width: e.width * scale, height: e.height * scale };
    }
    if (
      e.kind === "text" &&
      (patch.fontSize || patch.bold !== undefined || patch.italic !== undefined)
    ) {
      const count =
        this.measureTextLines?.(
          e.text ?? "",
          next.fontSize ?? 24,
          e.width,
          next,
        ) ?? Math.max(1, (e.text ?? "").split("\n").length);
      next.height = count * (next.fontSize ?? 24) * 1.35;
    }
    return next;
  }
  beginStyle() {
    if (!this.styleBefore) {
      this.commitText();
      this.styleBefore = this.elements;
    }
  }
  endStyle() {
    const before = this.styleBefore;
    if (!before) return;
    this.styleBefore = null;
    const after = this.elements;
    if (before === after) return;
    this.document = { ...this.document, elements: before };
    this.commit(after, "Свойства");
  }
  private groupMembers(el: SceneElement) {
    return el.groupId
      ? this.elements.filter((e) => e.groupId === el.groupId && !e.locked)
      : [el];
  }
  private moveMembers() {
    const selected = this.selection.filter((e) => !e.locked),
      frames = selected.filter((e) => e.kind === "frame");
    if (!frames.length) return selected;
    const inside = (e: SceneElement) => {
      const b = bounds(e);
      return frames.some(
        (f) =>
          b.minX >= f.x &&
          b.minY >= f.y &&
          b.maxX <= f.x + f.width &&
          b.maxY <= f.y + f.height,
      );
    };
    const groups = new Map<string, boolean>();
    for (const e of this.elements)
      if (e.groupId)
        groups.set(
          e.groupId,
          (groups.get(e.groupId) ?? true) && !e.locked && inside(e),
        );
    return this.elements.filter(
      (e) =>
        !e.locked &&
        (this.selected.has(e.id) ||
          (e.groupId ? groups.get(e.groupId) : inside(e))),
    );
  }
  private relatedPreview(preview: SceneElement[]) {
    if (!this.elements.some((e) => e.startBinding || e.endBinding))
      return preview;
    const map = new Map(preview.map((e) => [e.id, e]));
    const resolved = resolveBindings(
      this.elements.map((e) => map.get(e.id) ?? e),
    );
    return resolved.filter((e, i) => map.has(e.id) || e !== this.elements[i]);
  }
  group() {
    const picked = this.selection.filter((e) => !e.locked);
    if (picked.length < 2) return;
    const id = uid(),
      ids = new Set(picked.map((e) => e.id));
    this.commit(
      this.elements.map((e) => (ids.has(e.id) ? { ...e, groupId: id } : e)),
      "Группа",
    );
  }
  ungroup() {
    const groups = new Set(
      this.selection
        .filter((e) => !e.locked)
        .map((e) => e.groupId)
        .filter(Boolean),
    );
    if (!groups.size) return;
    this.commit(
      this.elements.map((e) =>
        groups.has(e.groupId) ? { ...e, groupId: undefined } : e,
      ),
      "Разгруппировка",
    );
  }
  lockSelection(locked = true) {
    if (!this.selected.size) return;
    this.commit(
      this.elements.map((e) =>
        this.selected.has(e.id) ? { ...e, locked } : e,
      ),
      locked ? "Блокировка" : "Разблокировка",
    );
    if (locked) this.selected.clear();
    this.emit("ui");
    this.emit("overlay");
  }
  unlockAll() {
    if (this.elements.some((e) => e.locked))
      this.commit(
        this.elements.map((e) => (e.locked ? { ...e, locked: false } : e)),
        "Разблокировка",
      );
  }
  detachConnectors() {
    if (
      !this.selection.some((e) => !e.locked && (e.startBinding || e.endBinding))
    )
      return;
    this.commit(
      this.elements.map((e) =>
        this.selected.has(e.id) && !e.locked
          ? { ...e, startBinding: undefined, endBinding: undefined }
          : e,
      ),
      "Отвязка стрелки",
    );
  }
  align(
    mode:
      | "left"
      | "center"
      | "right"
      | "top"
      | "middle"
      | "bottom"
      | "horizontal"
      | "vertical",
  ) {
    const units = new Map<string, SceneElement[]>();
    for (const e of this.selection.filter((e) => !e.locked)) {
      const key = e.groupId ?? e.id;
      units.set(key, [...(units.get(key) ?? []), e]);
    }
    const items = [...units.values()].map((els) => ({
      els,
      b: unionBounds(els)!,
    }));
    if (items.length < 2) return;
    const all = unionBounds(items.flatMap((i) => i.els))!,
      changes = new Map<string, SceneElement>();
    const horizontal = ["left", "center", "right", "horizontal"].includes(mode),
      axis = horizontal ? "x" : "y";
    const lo = axis === "x" ? "minX" : "minY",
      hi = axis === "x" ? "maxX" : "maxY";
    const distribute = mode === "horizontal" || mode === "vertical";
    if (distribute && items.length < 3) return;
    items.sort((a, b) => a.b[lo] - b.b[lo]);
    const gap =
      (all[hi] - all[lo] - items.reduce((n, i) => n + i.b[hi] - i.b[lo], 0)) /
      (items.length - 1);
    let cursor = all[lo];
    for (const item of items) {
      const delta = distribute
        ? cursor - item.b[lo]
        : mode === "left" || mode === "top"
          ? all[lo] - item.b[lo]
          : mode === "right" || mode === "bottom"
            ? all[hi] - item.b[hi]
            : (all[lo] + all[hi] - item.b[lo] - item.b[hi]) / 2;
      for (const e of item.els)
        changes.set(
          e.id,
          translateElement(e, horizontal ? delta : 0, horizontal ? 0 : delta),
        );
      cursor += item.b[hi] - item.b[lo] + gap;
    }
    this.commit(
      this.elements.map((e) => changes.get(e.id) ?? e),
      distribute ? "Равные интервалы" : "Выравнивание",
    );
  }
  private snapMove(original: SceneElement[], dx: number, dy: number) {
    this.guides = [];
    const b = unionBounds(original);
    if (!b) return { dx, dy };
    const ids = new Set(original.map((e) => e.id)),
      tolerance = 6 / this.camera.zoom;
    let bestX = tolerance,
      bestY = tolerance,
      adjustX = 0,
      adjustY = 0;
    const xs = [b.minX + dx, (b.minX + b.maxX) / 2 + dx, b.maxX + dx],
      ys = [b.minY + dy, (b.minY + b.maxY) / 2 + dy, b.maxY + dy];
    let gx: number | undefined, gy: number | undefined;
    for (const e of this.elements) {
      if (
        ids.has(e.id) ||
        e.kind === "arrow" ||
        e.kind === "line" ||
        e.kind === "frame"
      )
        continue;
      const other = bounds(e);
      for (const target of [
        other.minX,
        (other.minX + other.maxX) / 2,
        other.maxX,
      ])
        for (const x of xs)
          if (Math.abs(target - x) < bestX) {
            bestX = Math.abs(target - x);
            adjustX = target - x;
            gx = target;
          }
      for (const target of [
        other.minY,
        (other.minY + other.maxY) / 2,
        other.maxY,
      ])
        for (const y of ys)
          if (Math.abs(target - y) < bestY) {
            bestY = Math.abs(target - y);
            adjustY = target - y;
            gy = target;
          }
    }
    if (gx !== undefined) this.guides.push({ axis: "x", value: gx });
    if (gy !== undefined) this.guides.push({ axis: "y", value: gy });
    return { dx: dx + adjustX, dy: dy + adjustY };
  }
  focusElement(id: string) {
    const e = this.elements.find((e) => e.id === id);
    if (!e) return;
    this.selected = new Set([id]);
    this.fit(true);
    this.emit("ui");
  }
  patchElement(
    id: string,
    patch: Partial<SceneElement>,
    label = "Свойства объекта",
    allowLocked = false,
  ) {
    this.commit(
      this.elements.map((e) =>
        e.id === id && (allowLocked || !e.locked)
          ? { ...e, ...patch, id: e.id, kind: e.kind }
          : e,
      ),
      label,
    );
  }
  setDock(dock: Editor["dock"]) {
    this.dock = this.dock === dock ? null : dock;
    this.emit("ui");
  }
  selectObject(id: string, additive = false) {
    this.commitText();
    this.cancelGesture();
    this.tool = "select";
    if (!additive) this.selected.clear();
    if (additive && this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.emit("ui");
    this.emit("overlay");
  }
  moveLayer(id: string, delta: number) {
    const list = [...this.elements],
      i = list.findIndex((e) => e.id === id);
    if (i < 0) return;
    const to = clamp(i + delta, 0, list.length - 1);
    if (i === to) return;
    const [el] = list.splice(i, 1);
    list.splice(to, 0, el);
    this.commit(list, "Порядок объектов");
  }
  rotateSelection(degrees: number, absolute = false) {
    if (!Number.isFinite(degrees)) return;
    const original = this.selection;
    const delta = absolute ? degrees - (original[0]?.rotation ?? 0) : degrees;
    const changed = new Map(
      rotateElements(original, delta).map((e) => [e.id, e]),
    );
    const elements = this.elements.map((e) => changed.get(e.id) ?? e);
    if (this.styleBefore) {
      this.document = { ...this.document, elements: resolveBindings(elements) };
      this.emit("scene");
    } else this.commit(elements, "Поворот");
  }
  resizeSelection(width: number, height: number) {
    const b = this.selectionBounds;
    if (!b || width < 8 || height < 8 || !Number.isFinite(width + height))
      return;
    if (this.selection.some((e) => e.rotation)) {
      const w = b.maxX - b.minX,
        h = b.maxY - b.minY;
      if (Math.abs(width - w) > 0.001) height = (h * width) / w;
      else width = (w * height) / h;
    }
    const to = { ...b, maxX: b.minX + width, maxY: b.minY + height },
      changed = new Map(
        this.selection
          .filter((e) => !e.locked)
          .map((e) => [e.id, resizeElement(e, b, to)]),
      );
    const elements = this.elements.map((e) => changed.get(e.id) ?? e);
    if (this.styleBefore) {
      this.document = { ...this.document, elements: resolveBindings(elements) };
      this.emit("scene");
    } else this.commit(elements, "Размер");
  }
  insertElements(elements: SceneElement[]) {
    if (!elements.length) return;
    const b = unionBounds(elements)!;
    const p = screenToWorld(
      { x: this.viewport.width * 0.57, y: this.viewport.height / 2 },
      this.camera,
    );
    const copies = copyElements(
      elements,
      p.x - (b.minX + b.maxX) / 2,
      p.y - (b.minY + b.maxY) / 2,
    ).map((e) => ({ ...e, hidden: false }));
    this.selected = new Set(copies.map((e) => e.id));
    this.tool = "select";
    this.dock = "properties";
    this.commit([...this.elements, ...copies], "Вставка шаблона");
  }
  addStructured(kind: "table" | "task" | "link", cells?: string[][]) {
    this.objectDraftMode = "content";
    const p = screenToWorld(
      { x: this.viewport.width * 0.57, y: this.viewport.height / 2 },
      this.camera,
    );
    const element = createElement(kind, p.x - 180, p.y - 120, {
      ...this.style,
      fontSize: 18,
      fill: "#ffffff",
    });
    element.width =
      kind === "table" ? Math.max(360, (cells?.[0]?.length ?? 3) * 140) : 320;
    element.height =
      kind === "table"
        ? Math.max(180, (cells?.length ?? 3) * 48)
        : kind === "link"
          ? 100
          : 240;
    element.text =
      kind === "task" ? "Новая задача" : kind === "link" ? "Ссылка" : "Таблица";
    if (kind === "table")
      element.cells = cells ?? [
        ["Колонка 1", "Колонка 2", "Колонка 3"],
        ["", "", ""],
        ["", "", ""],
      ];
    if (kind === "task")
      element.task = {
        status: "todo",
        items: [{ id: uid(), text: "Первый пункт", done: false }],
      };
    if (kind === "link") element.link = { path: "", label: "Ссылка" };
    this.objectDraft = element;
    this.emit("ui");
  }
  saveObjectDraft(element: SceneElement) {
    const exists = this.elements.some((e) => e.id === element.id);
    this.objectDraft = null;
    this.selected = new Set([element.id]);
    this.tool = "select";
    this.dock = "properties";
    this.commit(
      exists
        ? this.elements.map((e) => (e.id === element.id ? element : e))
        : [...this.elements, element],
      "Редактирование объекта",
    );
  }
  get slides() {
    return this.elements
      .filter((e) => e.kind === "frame" && !e.hidden)
      .sort(
        (a, b) => (a.slideOrder ?? a.createdAt) - (b.slideOrder ?? b.createdAt),
      );
  }
  reorderSlide(id: string, delta: number) {
    const slides = this.slides,
      i = slides.findIndex((e) => e.id === id),
      to = clamp(i + delta, 0, slides.length - 1);
    if (i < 0 || i === to) return;
    const [s] = slides.splice(i, 1);
    slides.splice(to, 0, s);
    const order = new Map(slides.map((e, i) => [e.id, i]));
    this.commit(
      this.elements.map((e) =>
        order.has(e.id) ? { ...e, slideOrder: order.get(e.id) } : e,
      ),
      "Порядок слайдов",
    );
  }
  showSlide(id: string) {
    if (this.presenting) this.presentationFrame = id;
    const e = this.elements.find((e) => e.id === id);
    if (!e) return;
    const b = bounds(e),
      z = clamp(
        Math.min(
          (this.viewport.width - 80) / (b.maxX - b.minX),
          (this.viewport.height - 110) / (b.maxY - b.minY),
        ),
        0.05,
        8,
      );
    this.setCamera({
      zoom: z,
      x: this.viewport.width / 2 - ((b.minX + b.maxX) * z) / 2,
      y: (this.viewport.height - 30) / 2 - ((b.minY + b.maxY) * z) / 2,
    });
  }
  showContextMenu(point: Vec) {
    if (!this.enabled || this.replay) return;
    this.commitText();
    this.cancelGesture();
    const e = this.pick(screenToWorld(point, this.camera), true);
    if (e && !this.selected.has(e.id))
      this.selected = new Set(
        (e.locked ? [e] : this.groupMembers(e)).map((e) => e.id),
      );
    if (!e) this.selected.clear();
    this.contextMenu = point;
    this.emit("ui");
    this.emit("overlay");
  }
  saveFormula(text: string, width: number, height: number) {
    const draft = this.formulaDraft;
    if (!draft) return;
    const el = { ...draft, text, width, height };
    this.formulaDraft = null;
    this.selected = new Set([el.id]);
    this.commit(
      this.elements.some((e) => e.id === el.id)
        ? this.elements.map((e) => (e.id === el.id ? el : e))
        : [...this.elements, el],
      "Формула",
    );
    this.tool = "select";
    this.emit("ui");
  }
  addImage(dataUrl: string, width: number, height: number) {
    const factor = Math.min(1, 720 / Math.max(width, height));
    const p = screenToWorld(
      { x: this.viewport.width / 2, y: this.viewport.height / 2 },
      this.camera,
    );
    const el = {
      ...createElement(
        "image",
        p.x - (width * factor) / 2,
        p.y - (height * factor) / 2,
        this.style,
      ),
      width: width * factor,
      height: height * factor,
      dataUrl,
    };
    this.selected = new Set([el.id]);
    this.commit([...this.elements, el], "Изображение");
    this.tool = "select";
    this.emit("ui");
  }
  setCamera(camera: Camera) {
    this.camera = { ...camera, zoom: clamp(camera.zoom, 0.05, 8) };
    this.emit("camera");
  }
  zoom(
    factor: number,
    point = { x: this.viewport.width / 2, y: this.viewport.height / 2 },
  ) {
    this.setCamera(zoomAt(this.camera, point, factor));
  }
  fit(selection = false) {
    const b = unionBounds(
      selection && this.selected.size
        ? this.selection
        : this.elements.filter((e) => !e.hidden),
    );
    if (!b) {
      this.setCamera({
        x: this.viewport.width / 2 - 400,
        y: this.viewport.height / 2 - 220,
        zoom: 1,
      });
      return;
    }
    const width = Math.max(80, b.maxX - b.minX),
      height = Math.max(80, b.maxY - b.minY);
    const left = this.dock ? 360 : 96,
      right = 48,
      top = 40,
      bottom = 72;
    const zoom = clamp(
      Math.min(
        Math.max(240, this.viewport.width - left - right) / width,
        Math.max(200, this.viewport.height - top - bottom) / height,
      ),
      0.05,
      1.5,
    );
    this.setCamera({
      zoom,
      x:
        (left + this.viewport.width - right) / 2 -
        ((b.minX + b.maxX) / 2) * zoom,
      y:
        (top + this.viewport.height - bottom) / 2 -
        ((b.minY + b.maxY) / 2) * zoom,
    });
  }
  pick(p: Vec, includeLocked = false) {
    const t = 6 / this.camera.zoom;
    for (let i = this.elements.length - 1; i >= 0; i--) {
      const e = this.elements[i];
      if (!e.hidden && (includeLocked || !e.locked) && hitTest(e, p, t))
        return e;
    }
    return null;
  }
  private handleAt(p: Vec): number {
    const b = this.selectionBounds;
    if (!b) return -1;
    const corners = [
      { x: b.minX, y: b.minY },
      { x: b.maxX, y: b.minY },
      { x: b.maxX, y: b.maxY },
      { x: b.minX, y: b.maxY },
    ];
    return corners.findIndex(
      (c) => Math.hypot(p.x - c.x, p.y - c.y) < 9 / this.camera.zoom,
    );
  }
  pointerDown(
    screen: Vec,
    id: number,
    sample: PointerSample,
    button: number,
    shift: boolean,
  ) {
    if (
      !this.enabled ||
      this.presenting ||
      this.replay ||
      this.gesture ||
      button === 2
    )
      return false;
    this.endStyle();
    this.contextMenu = null;
    this.commitText();
    this.pointer = screen;
    const p = screenToWorld(screen, this.camera);
    if (button === 1 || this.tool === "hand" || this.spaceHeld) {
      this.gesture = {
        type: "pan",
        pointer: id,
        start: screen,
        camera: { ...this.camera },
      };
      return true;
    }
    const tool =
      sample.pointerType === "pen" && button === 5 ? "eraser" : this.tool;
    if (tool === "pen" || tool === "highlighter") {
      const el = createElement("stroke", p.x, p.y, {
        ...this.style,
        ...(tool === "highlighter"
          ? {
              strokeWidth: this.markerSize,
              opacity: Math.min(0.6, this.style.opacity * 0.32),
            }
          : {}),
      });
      el.points = [[0, 0, this.pressure(sample), 0]];
      el.ink = { ...this.pen };
      this.gesture = {
        type: "ink",
        element: el,
        pointer: id,
        startTime: sample.time,
      };
      this.selected.clear();
      this.emit("ui");
      this.emit("overlay");
      return true;
    }
    if (tool === "eraser") {
      this.gesture = { type: "erase", pointer: id, erased: new Set(), last: p };
      this.eraseAt(p);
      return true;
    }
    if (tool === "math") {
      this.formulaDraft = {
        ...createElement("math", p.x, p.y, this.style),
        width: 240,
        height: 80,
        text: "",
      };
      this.emit("ui");
      return false;
    }
    if (tool === "table" || tool === "task" || tool === "link") {
      this.addStructured(tool);
      return false;
    }
    if (tool === "text") {
      const found = this.pick(p);
      if (found && (found.kind === "text" || found.kind === "sticky"))
        this.startText(found, false);
      else {
        const el = createElement(tool, p.x, p.y, this.style);
        el.width = 300;
        el.height = 42;
        this.startText(el, true);
      }
      return false;
    }
    if (tool !== "select") {
      this.selected.clear();
      const element = createElement(
        tool === "connector" ? "arrow" : tool,
        p.x,
        p.y,
        this.style,
      );
      if (tool === "connector")
        element.startBinding = bindingAt(
          p,
          this.elements,
          12 / this.camera.zoom,
        );
      if (["connector", "arrow", "line"].includes(tool))
        element.connectorStyle = this.connectorStyle;
      if (tool === "frame") {
        element.fill = "transparent";
        element.text = "Фрейм";
        element.fontSize = 20;
      }
      if (tool === "sticky")
        element.fill =
          this.style.fill === "transparent" ? "#fff1a8" : this.style.fill;
      if (tool === "arrow" || tool === "line" || tool === "connector") {
        element.endX = 0;
        element.endY = 0;
      }
      this.gesture = { type: "shape", element, pointer: id, start: p };
      this.emit("ui");
      this.emit("overlay");
      return true;
    }
    const connector = this.selection.length === 1 ? this.selection[0] : null;
    const boundConnector =
      connector?.kind === "arrow" &&
      (connector.startBinding || connector.endBinding);
    if (boundConnector && !connector.locked) {
      const a = { x: connector.x, y: connector.y },
        b = {
          x: connector.x + (connector.endX ?? 0),
          y: connector.y + (connector.endY ?? 0),
        };
      const atStart = Math.hypot(p.x - a.x, p.y - a.y) < 10 / this.camera.zoom,
        atEnd = Math.hypot(p.x - b.x, p.y - b.y) < 10 / this.camera.zoom;
      if (atStart || atEnd) {
        this.gesture = {
          type: "endpoint",
          element: connector,
          pointer: id,
          start: atStart,
        };
        return true;
      }
    }
    const rotateBounds = this.selectionBounds;
    if (
      rotateBounds &&
      !this.selection.some((e) => e.locked || e.startBinding || e.endBinding) &&
      Math.hypot(
        p.x - (rotateBounds.minX + rotateBounds.maxX) / 2,
        p.y - (rotateBounds.minY - 28 / this.camera.zoom),
      ) <
        9 / this.camera.zoom
    ) {
      const center = {
        x: (rotateBounds.minX + rotateBounds.maxX) / 2,
        y: (rotateBounds.minY + rotateBounds.maxY) / 2,
      };
      this.gesture = {
        type: "rotate",
        pointer: id,
        center,
        startAngle: Math.atan2(p.y - center.y, p.x - center.x),
        original: this.selection,
        preview: this.selection,
        moved: false,
      };
      return true;
    }
    const handle = boundConnector ? -1 : this.handleAt(p),
      from = this.selectionBounds;
    if (handle >= 0 && from && !this.selection.some((e) => e.locked)) {
      const original = this.selection;
      this.gesture = {
        type: "resize",
        pointer: id,
        start: p,
        handle,
        from,
        original,
        preview: original,
        moved: false,
      };
      return true;
    }
    let found = this.pick(p);
    if (found?.kind === "task" && found.task && !shift) {
      const q = found.rotation
        ? rotatePoint(p, rotationCenter(found), -found.rotation)
        : p;
      const row = Math.floor((q.y - found.y - 76) / 30);
      if (
        q.x - found.x >= 16 &&
        q.x - found.x <= 40 &&
        row >= 0 &&
        row < found.task.items.length
      ) {
        this.patchElement(
          found.id,
          {
            task: {
              ...found.task,
              items: found.task.items.map((item, i) =>
                i === row ? { ...item, done: !item.done } : item,
              ),
            },
          },
          "Пункт задачи",
        );
        return false;
      }
    }
    if (
      !found &&
      this.selected.size === 1 &&
      !this.selection[0].locked &&
      from &&
      contains(from, p)
    )
      found = this.selection[0];
    if (found) {
      this.dock = "properties";
      const members = this.groupMembers(found);
      if (shift) {
        const remove = this.selected.has(found.id);
        for (const member of members) {
          if (remove) this.selected.delete(member.id);
          else this.selected.add(member.id);
        }
      } else if (!this.selected.has(found.id))
        this.selected = new Set(members.map((e) => e.id));
      const original = this.moveMembers();
      this.gesture = {
        type: "move",
        pointer: id,
        start: p,
        original,
        preview: original,
        moved: false,
      };
    } else {
      const previous = shift ? new Set(this.selected) : new Set<string>();
      if (!shift) this.selected.clear();
      this.gesture = {
        type: "marquee",
        pointer: id,
        start: p,
        end: p,
        previous,
      };
    }
    this.emit("ui");
    this.emit("overlay");
    return true;
  }
  pressure(s: PointerSample) {
    return s.pointerType === "pen"
      ? Math.pow(clamp(s.pressure || 0.05, 0.05, 1), 100 / this.pen.pressure)
      : 0.5;
  }
  pointerMove(screen: Vec, id: number, sample: PointerSample, shift: boolean) {
    this.pointer = screen;
    const g = this.gesture;
    if (!g || g.pointer !== id) {
      if (this.tool === "eraser") this.emit("overlay");
      return;
    }
    const p = screenToWorld(screen, this.camera);
    if (g.type === "rotate") {
      let delta =
        ((Math.atan2(p.y - g.center.y, p.x - g.center.x) - g.startAngle) *
          180) /
        Math.PI;
      if (shift) delta = Math.round(delta / 15) * 15;
      const first = !g.moved;
      g.moved = true;
      g.preview = rotateElements(g.original, delta, g.center);
      this.emit(first ? "scene" : "overlay");
      return;
    }
    if (g.type === "endpoint") {
      const el = g.element,
        binding = bindingAt(p, this.elements, 12 / this.camera.zoom);
      const end = { x: el.x + (el.endX ?? 0), y: el.y + (el.endY ?? 0) };
      g.element = g.start
        ? {
            ...el,
            x: p.x,
            y: p.y,
            endX: end.x - p.x,
            endY: end.y - p.y,
            startBinding: binding,
          }
        : { ...el, endX: p.x - el.x, endY: p.y - el.y, endBinding: binding };
      g.element = {
        ...g.element,
        width: Math.abs(g.element.endX ?? 0),
        height: Math.abs(g.element.endY ?? 0),
      };
      g.element = resolveBindings([
        ...this.elements.filter((e) => e.id !== el.id),
        g.element,
      ]).at(-1)!;
      this.emit("scene");
      return;
    }
    if (g.type === "pan") {
      this.setCamera({
        ...g.camera,
        x: g.camera.x + screen.x - g.start.x,
        y: g.camera.y + screen.y - g.start.y,
      });
      return;
    }
    if (g.type === "ink") {
      const pts = g.element.points!,
        last = pts.at(-1)!,
        x = p.x - g.element.x,
        y = p.y - g.element.y,
        pressure = this.pressure(sample);
      if (
        (Math.hypot(x - last[0], y - last[1]) < 0.25 / this.camera.zoom &&
          Math.abs(pressure - last[2]) < 0.02) ||
        pts.length >= 200_000
      )
        return;
      const filtered =
        sample.pointerType === "pen" ? last[2] * 0.35 + pressure * 0.65 : 0.5;
      pts.push([x, y, filtered, Math.max(0, sample.time - g.startTime)]);
      this.emit("overlay");
      return;
    }
    if (g.type === "shape") {
      let dx = p.x - g.start.x,
        dy = p.y - g.start.y;
      if (shift) {
        if (g.element.kind === "arrow" || g.element.kind === "line") {
          const r = Math.hypot(dx, dy),
            a = (Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI) / 4;
          dx = Math.cos(a) * r;
          dy = Math.sin(a) * r;
        } else {
          const size = Math.max(Math.abs(dx), Math.abs(dy));
          dx = Math.sign(dx || 1) * size;
          dy = Math.sign(dy || 1) * size;
        }
      }
      if (g.element.kind === "arrow" || g.element.kind === "line")
        g.element = {
          ...g.element,
          x: g.start.x,
          y: g.start.y,
          endX: dx,
          endY: dy,
          width: Math.abs(dx),
          height: Math.abs(dy),
        };
      else
        g.element = {
          ...g.element,
          x: Math.min(g.start.x, g.start.x + dx),
          y: Math.min(g.start.y, g.start.y + dy),
          width: Math.abs(dx),
          height: Math.abs(dy),
        };
      if (this.tool === "connector") {
        g.element.endBinding = bindingAt(
          p,
          this.elements,
          12 / this.camera.zoom,
        );
        g.element = resolveBindings([...this.elements, g.element]).at(-1)!;
      }
      this.emit("overlay");
      return;
    }
    if (g.type === "move") {
      let dx = p.x - g.start.x,
        dy = p.y - g.start.y;
      if (this.snap && !shift) ({ dx, dy } = this.snapMove(g.original, dx, dy));
      else this.guides = [];
      if (!g.moved && Math.hypot(dx, dy) * this.camera.zoom < 3) return;
      const first = !g.moved;
      g.moved = true;
      g.preview = g.original.map((e) => translateElement(e, dx, dy));
      this.emit(first ? "scene" : "overlay");
      return;
    }
    if (g.type === "resize") {
      const to = { ...g.from },
        minSize = 8 / this.camera.zoom;
      if (g.handle === 0 || g.handle === 3)
        to.minX = Math.min(p.x, to.maxX - minSize);
      else to.maxX = Math.max(p.x, to.minX + minSize);
      if (g.handle === 0 || g.handle === 1)
        to.minY = Math.min(p.y, to.maxY - minSize);
      else to.maxY = Math.max(p.y, to.minY + minSize);
      if (shift || g.original.some((e) => e.rotation)) {
        const ratio =
            (g.from.maxX - g.from.minX) /
            Math.max(0.001, g.from.maxY - g.from.minY),
          w = to.maxX - to.minX,
          h = w / ratio;
        if (g.handle === 0 || g.handle === 1) to.minY = to.maxY - h;
        else to.maxY = to.minY + h;
      }
      const first = !g.moved;
      g.moved = true;
      g.preview = g.original.map((e) => resizeElement(e, g.from, to));
      this.emit(first ? "scene" : "overlay");
      return;
    }
    if (g.type === "marquee") {
      g.end = p;
      const r = rectFromPoints(g.start, p);
      const hits = this.elements.filter(
          (e) =>
            !e.hidden &&
            !e.locked &&
            (g.previous.has(e.id) || intersects(bounds(e), r)),
        ),
        ids = new Set(hits.map((e) => e.id)),
        groups = new Set(hits.map((e) => e.groupId).filter(Boolean));
      this.selected = new Set(
        this.elements
          .filter(
            (e) =>
              !e.locked &&
              (ids.has(e.id) || (e.groupId && groups.has(e.groupId))),
          )
          .map((e) => e.id),
      );
      this.emit("overlay");
      return;
    }
    if (g.type === "erase") {
      this.eraseAt(p, g.last);
      g.last = p;
      this.emit("overlay");
    }
  }
  private eraseAt(p: Vec, from = p) {
    const g = this.gesture;
    if (g?.type !== "erase") return;
    let changed = false;
    for (const el of this.elements)
      if (
        !g.erased.has(el.id) &&
        !el.locked &&
        !el.hidden &&
        sweepHitTest(el, from, p, this.eraserSize / 2 / this.camera.zoom)
      ) {
        g.erased.add(el.id);
        changed = true;
      }
    if (changed) this.emit("scene");
  }
  pointerUp(id: number) {
    const g = this.gesture;
    if (!g || g.pointer !== id) return;
    this.gesture = null;
    this.guides = [];
    if (g.type === "ink") {
      const el = { ...g.element, points: [...g.element.points!] };
      const b = bounds(el);
      el.width = b.maxX - b.minX;
      el.height = b.maxY - b.minY;
      this.commit([...this.elements, el], "Штрих");
    } else if (g.type === "endpoint") {
      this.commit(
        this.elements.map((e) => (e.id === g.element.id ? g.element : e)),
        "Конец соединителя",
      );
    } else if (g.type === "shape") {
      let el = g.element;
      if (el.kind === "sticky") {
        const click =
          el.width * this.camera.zoom < 3 && el.height * this.camera.zoom < 3;
        const width = click ? 220 : Math.max(80, el.width),
          height = click ? 180 : Math.max(80, el.height);
        el = {
          ...el,
          width,
          height,
          x: !click && el.x < g.start.x ? g.start.x - width : el.x,
          y: !click && el.y < g.start.y ? g.start.y - height : el.y,
        };
        this.startText(el, true);
        return;
      }
      if (el.width * this.camera.zoom < 3 && el.height * this.camera.zoom < 3) {
        el = {
          ...el,
          width: 160,
          height: 100,
          ...(el.kind === "arrow" || el.kind === "line"
            ? { endX: 160, endY: 0, height: 0 }
            : {}),
        };
      }
      this.commit(
        el.kind === "frame" ? [el, ...this.elements] : [...this.elements, el],
        "Фигура",
      );
    } else if (
      (g.type === "move" || g.type === "resize" || g.type === "rotate") &&
      g.moved
    ) {
      const changed = new Map(g.preview.map((e) => [e.id, e]));
      this.commit(
        this.elements.map((e) => changed.get(e.id) ?? e),
        g.type === "move"
          ? "Перемещение"
          : g.type === "rotate"
            ? "Поворот"
            : "Размер",
      );
    } else if (g.type === "erase" && g.erased.size)
      this.commit(
        this.elements.filter((e) => !g.erased.has(e.id)),
        "Ластик",
      );
    else this.emit("ui");
    this.emit("scene");
  }
  cancelGesture() {
    this.guides = [];
    if (this.gesture) {
      this.gesture = null;
      this.emit("scene");
    }
  }
  doubleClick(screen: Vec) {
    if (this.replay) return;
    const el = this.pick(screenToWorld(screen, this.camera));
    if (el && ["table", "task", "link"].includes(el.kind)) {
      this.cancelGesture();
      this.objectDraftMode = "content";
      this.objectDraft = el;
      this.emit("ui");
      return;
    }
    if (el?.kind === "math") {
      this.formulaDraft = el;
      this.emit("ui");
      return;
    }
    if (
      el &&
      (el.kind === "text" || el.kind === "sticky" || el.kind === "frame")
    ) {
      this.cancelGesture();
      this.startText(el, false);
    }
  }
  startText(element: SceneElement, isNew: boolean) {
    this.commitText();
    this.selected.clear();
    this.editing = { element, isNew, value: element.text ?? "" };
    this.emit("scene");
  }
  updateText(value: string) {
    if (!this.editing) return;
    this.editing = { ...this.editing, value: value.slice(0, 100_000) };
    this.emit("ui");
  }
  commitText() {
    const edit = this.editing;
    if (!edit) return;
    this.editing = null;
    const value = edit.value.trimEnd();
    if (!value && edit.isNew && edit.element.kind === "text") {
      this.emit("scene");
      return;
    }
    if (!edit.isNew && value === (edit.element.text ?? "")) {
      this.emit("scene");
      return;
    }
    const element = { ...edit.element, text: value };
    if (element.kind === "text")
      element.height =
        Math.max(
          1,
          this.measureTextLines?.(
            value,
            element.fontSize ?? 24,
            element.width,
            element,
          ) ??
            value
              .split("\n")
              .reduce(
                (n, l) =>
                  n +
                  Math.max(
                    1,
                    Math.ceil(
                      l.length /
                        Math.max(
                          1,
                          element.width / ((element.fontSize ?? 24) * 0.55),
                        ),
                    ),
                  ),
                0,
              ),
        ) *
        (element.fontSize ?? 24) *
        1.35;
    this.selected = new Set([element.id]);
    this.commit(
      edit.isNew
        ? [...this.elements, element]
        : this.elements.map((e) => (e.id === element.id ? element : e)),
      "Текст",
    );
  }
  cancelText() {
    this.editing = null;
    this.emit("scene");
  }
  visibleBounds(): Bounds {
    const a = screenToWorld({ x: 0, y: 0 }, this.camera),
      b = screenToWorld(
        { x: this.viewport.width, y: this.viewport.height },
        this.camera,
      );
    return expand(rectFromPoints(a, b), 60 / this.camera.zoom);
  }
  startReplay() {
    this.commitText();
    this.cancelGesture();
    this.selected.clear();
    this.replay = {
      progress: 0,
      playing: true,
      speed: 1,
      duration:
        this.elements.reduce((n, e) => n + this.elementDuration(e), 0) || 1,
      lastTime: 0,
    };
    this.emit("scene");
  }
  elementDuration(el: SceneElement) {
    return el.kind === "stroke"
      ? clamp(el.points?.at(-1)?.[3] ?? 300, 180, 6000)
      : 350;
  }
  toggleReplay() {
    if (!this.replay) {
      this.startReplay();
      return;
    }
    this.replay = {
      ...this.replay,
      playing: !this.replay.playing,
      progress: this.replay.progress >= 1 ? 0 : this.replay.progress,
      lastTime: 0,
    };
    this.emit("ui");
  }
  seekReplay(progress: number) {
    if (!this.replay) return;
    this.replay = {
      ...this.replay,
      progress: clamp(progress, 0, 1),
      lastTime: 0,
    };
    this.emit("scene");
  }
  speedReplay(speed: number) {
    if (this.replay) {
      this.replay = { ...this.replay, speed, lastTime: 0 };
      this.emit("ui");
    }
  }
  stopReplay() {
    if (this.replay) {
      this.replay = null;
      this.emit("scene");
    }
  }
  tickReplay(now: number) {
    const r = this.replay;
    if (!r?.playing) return;
    if (r.lastTime)
      r.progress = clamp(
        r.progress + ((now - r.lastTime) * r.speed) / r.duration,
        0,
        1,
      );
    r.lastTime = now;
    if (r.progress >= 1) r.playing = false;
    if (now - this.lastReplayUi > 100 || !r.playing) {
      this.lastReplayUi = now;
      this.emit("ui");
    }
  }
}

export function exampleDocument(): BoardDocument {
  const doc = createDocument("Пространство для идей");
  const style = { ...DEFAULT_STYLE, color: "#242424" };
  const text = (
    x: number,
    y: number,
    width: number,
    text: string,
    size = 24,
  ): SceneElement => ({
    ...createElement("text", x, y, style),
    width,
    height: size * 1.5,
    text,
    fontSize: size,
  });
  doc.elements = [
    text(60, 30, 720, "Дайте идее форму", 38),
    text(62, 92, 720, "Рисуйте. Соединяйте. Сохраняйте.", 18),
    {
      ...createElement("sticky", 70, 165, style),
      width: 220,
      height: 180,
      fill: "#fff1a8",
      text: "С чего начнём?\n\nОдна мысль —\nодин стикер.",
      fontSize: 20,
    },
    {
      ...createElement("sticky", 430, 165, style),
      width: 220,
      height: 180,
      fill: "#cfe9fd",
      text: "А что, если…\n\nЗдесь можно\nпопробовать всё.",
      fontSize: 20,
    },
    {
      ...createElement("arrow", 310, 252, {
        ...style,
        color: "#0f6cbd",
        strokeWidth: 3,
      }),
      width: 90,
      height: 0,
      endX: 90,
      endY: 0,
    },
    text(
      72,
      405,
      680,
      "P — перо     V — выделение     Space — перемещение",
      15,
    ),
    {
      ...createElement("stroke", 65, 140, {
        ...style,
        color: "#0f6cbd",
        strokeWidth: 4,
      }),
      width: 290,
      height: 9,
      points: Array.from(
        { length: 64 },
        (_, i) => [i * 4.6, Math.sin(i / 16) * 4, 0.5, i * 6] as InkPoint,
      ),
    },
  ];
  return doc;
}
