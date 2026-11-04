import type {
  BoardDocument,
  Bounds,
  SceneElement,
} from "../editor/model/types";
import { bounds, unionBounds, intersects } from "../editor/model/geometry";
import { pagesOf, pageElements } from "../editor/model/pages";

export type ExportFormat = "png" | "svg" | "pdf" | "zip";
export type ExportScope =
  "page" | "selection" | "frame" | "region" | "pages" | "frames" | "workspace";

/** Shared UI/MCP contract. Pixel sizes preserve the document aspect ratio. */
export interface ExportRequest {
  format: ExportFormat;
  scope: ExportScope;
  pageId?: string;
  pageIds?: string[];
  frameId?: string;
  frameIds?: string[];
  region?: { x: number; y: number; width: number; height: number };
  scale?: number;
  pixelWidth?: number;
  pixelHeight?: number;
  transparent?: boolean;
  padding?: number;
  layout?: { columns?: number; gap?: number };
  pdfPageSize?: "content" | "a4" | "a3";
}

export const EXPORT_LIMITS = Object.freeze({
  rasterSide: 16_384,
  rasterPixels: 64_000_000,
  outputBytes: 256 * 1024 * 1024,
  svgBytes: 64 * 1024 * 1024,
  workingBytes: 1024 * 1024 * 1024,
  pdfSide: 14_000,
});

export interface ExportSnapshot {
  readonly document: BoardDocument;
  readonly activePageId: string;
  readonly selectionIds: readonly string[];
}

export interface ExportPagePlan {
  id: string;
  pageId: string;
  title: string;
  filename: string;
  frameId?: string;
  ids?: string[];
  bounds: Bounds;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  /** Placement in a single PNG, in output pixels. */
  x: number;
  y: number;
  pdfWidth: number;
  pdfHeight: number;
  estimatedVectorBytes: number;
  empty: boolean;
}

export interface ExportPlan {
  format: ExportFormat;
  extension: ExportFormat;
  mime: string;
  title: string;
  pages: ExportPagePlan[];
  width?: number;
  height?: number;
  estimatedWorkingBytes: number;
  totalPixels: number;
  transparent: boolean;
  warnings: string[];
  limits: typeof EXPORT_LIMITS;
}

export class ExportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExportError";
  }
}

const mime: Record<ExportFormat, string> = {
  png: "image/png",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
};

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) freeze(v);
  }
  return value;
}

/** Clone once, before any await or file dialog. Neither camera nor editor is used. */
export function captureExportSnapshot(
  document: BoardDocument,
  options: { activePageId?: string; selectionIds?: Iterable<string> } = {},
): ExportSnapshot {
  const copy = structuredClone(document);
  const pages = pagesOf(copy);
  const activePageId = options.activePageId ?? pages[0]?.id;
  if (!activePageId || !pages.some((p) => p.id === activePageId))
    throw new ExportError(
      "PAGE_NOT_FOUND",
      "Страница для экспорта не найдена.",
    );
  return freeze({
    document: copy,
    activePageId,
    selectionIds: [...new Set(options.selectionIds ?? [])],
  });
}

export function safeExportName(title: string, fallback = "Страница"): string {
  const clean = title
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "")
    .slice(0, 100)
    .replace(/[. ]+$/g, "");
  const name = clean || fallback;
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
    ? `_${name}`
    : name;
}

function positive(value: number, name: string, integer = false): number {
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    (integer && !Number.isInteger(value))
  )
    throw new ExportError(
      "INVALID_SIZE",
      `${name}: задайте положительное ${integer ? "целое " : ""}число.`,
    );
  return value;
}

function pixelSize(w: number, h: number, request: ExportRequest) {
  const scale =
    request.scale === undefined ? 2 : positive(request.scale, "Масштаб");
  const pw = request.pixelWidth,
    ph = request.pixelHeight;
  if (pw !== undefined) positive(pw, "Ширина в пикселях", true);
  if (ph !== undefined) positive(ph, "Высота в пикселях", true);
  if (pw !== undefined && ph !== undefined && Math.abs(ph - (pw * h) / w) > 1)
    throw new ExportError(
      "ASPECT_RATIO",
      "Ширина и высота должны сохранять пропорции. Задайте только одну сторону.",
    );
  return {
    width:
      pw ??
      (ph === undefined
        ? Math.max(1, Math.ceil(w * scale))
        : Math.max(1, Math.round((ph * w) / h))),
    height:
      ph ??
      (pw === undefined
        ? Math.max(1, Math.ceil(h * scale))
        : Math.max(1, Math.round((pw * h) / w))),
  };
}

function checkRaster(width: number, height: number) {
  if (
    width > EXPORT_LIMITS.rasterSide ||
    height > EXPORT_LIMITS.rasterSide ||
    width * height > EXPORT_LIMITS.rasterPixels
  )
    throw new ExportError(
      "RASTER_LIMIT",
      `Размер ${width.toLocaleString("ru-RU")} × ${height.toLocaleString("ru-RU")} превышает предел PNG: 16 384 px по стороне и 64 Мп. Уменьшите масштаб, выберите область или отдельные PNG в ZIP. Качество автоматически не уменьшается.`,
    );
}

function expanded(b: Bounds, padding: number): Bounds {
  return {
    minX: b.minX - padding,
    minY: b.minY - padding,
    maxX: b.maxX + padding,
    maxY: b.maxY + padding,
  };
}

function vectorEstimate(elements: SceneElement[]): number {
  let bytes = 4096;
  for (const e of elements) {
    bytes += 800 + (e.points?.length ?? 0) * 100 + (e.route?.length ?? 0) * 80;
    bytes +=
      (e.dataUrl?.length ?? 0) +
      (e.text?.length ?? 0) * (e.kind === "math" ? 300 : 8);
    for (const row of e.cells ?? [])
      for (const cell of row) bytes += cell.length * 8 + 400;
    for (const item of e.task?.items ?? []) bytes += item.text.length * 8 + 500;
  }
  return bytes;
}

function pdfDimensions(
  w: number,
  h: number,
  size: ExportRequest["pdfPageSize"],
) {
  if (!size || size === "content") {
    if (Math.max(w, h) > EXPORT_LIMITS.pdfSide)
      throw new ExportError(
        "PDF_SIZE",
        "Область больше 14 000 pt по стороне PDF. Выберите лист A4/A3 или экспорт отдельных областей; размер не будет изменён автоматически.",
      );
    return { width: w, height: h };
  }
  const short = size === "a3" ? 841.89 : 595.28;
  const long = size === "a3" ? 1190.55 : 841.89;
  return w > h
    ? { width: long, height: short }
    : { width: short, height: long };
}

/** Pure preflight: errors happen before creating a canvas or opening a save dialog. */
export function planExport(
  snapshot: ExportSnapshot,
  request: ExportRequest,
): ExportPlan {
  if (!Object.hasOwn(mime, request.format))
    throw new ExportError("FORMAT", "Неизвестный формат экспорта.");
  const scope = request.scope;
  if (
    ![
      "page",
      "selection",
      "frame",
      "region",
      "pages",
      "frames",
      "workspace",
    ].includes(scope)
  )
    throw new ExportError("SCOPE", "Неизвестная область экспорта.");
  const allPages = pagesOf(snapshot.document);
  const chosenIds =
    request.pageIds ??
    (scope === "pages" || scope === "workspace"
      ? allPages.map((p) => p.id)
      : [request.pageId ?? snapshot.activePageId]);
  if (!chosenIds.length || new Set(chosenIds).size !== chosenIds.length)
    throw new ExportError("PAGE_IDS", "Выберите страницы без повторений.");
  const selectedPages = chosenIds.map((id) => {
    const p = allPages.find((page) => page.id === id);
    if (!p)
      throw new ExportError(
        "PAGE_NOT_FOUND",
        "Одна из страниц больше не существует.",
      );
    return p;
  });
  if (
    !["pages", "workspace", "frames"].includes(scope) &&
    selectedPages.length !== 1
  )
    throw new ExportError(
      "PAGE_IDS",
      "Для этой области выберите одну страницу.",
    );
  const padding = request.padding ?? 24;
  if (!Number.isFinite(padding) || padding < 0 || padding > 10_000)
    throw new ExportError("PADDING", "Отступ должен быть от 0 до 10 000.");
  const warnings: string[] = [];
  const targets: {
    pageId: string;
    title: string;
    frame?: SceneElement;
    elements: SceneElement[];
    b: Bounds;
    ids?: string[];
    empty: boolean;
  }[] = [];
  for (const p of selectedPages) {
    const visible = pageElements(snapshot.document, p.id).filter(
      (e) => !e.hidden,
    );
    const ids =
      scope === "selection" ? new Set(snapshot.selectionIds) : undefined;
    let content = ids ? visible.filter((e) => ids.has(e.id)) : visible;
    if (scope === "selection" && !content.length)
      throw new ExportError(
        "EMPTY_SELECTION",
        "Выделите видимые объекты перед экспортом.",
      );
    if (scope === "frame" || scope === "frames") {
      const frames = visible
        .filter((e) => e.kind === "frame")
        .sort(
          (a, b) =>
            (a.slideOrder ?? Number.MAX_SAFE_INTEGER) -
              (b.slideOrder ?? Number.MAX_SAFE_INTEGER) ||
            a.createdAt - b.createdAt,
        );
      const requestedIds =
        scope === "frame" ? [request.frameId] : request.frameIds;
      if (scope === "frame" && !request.frameId)
        throw new ExportError("FRAME_REQUIRED", "Выберите фрейм для экспорта.");
      const chosen = requestedIds
        ? requestedIds
            .map((id) => frames.find((f) => f.id === id))
            .filter((e): e is SceneElement => !!e)
        : frames;
      if (
        scope === "frame" &&
        requestedIds &&
        chosen.length !== requestedIds.length
      )
        throw new ExportError(
          "FRAME_NOT_FOUND",
          "Выбранный фрейм не найден на странице или скрыт.",
        );
      for (const frame of chosen) {
        const b = frame.rotation
          ? bounds(frame)
          : {
              minX: frame.x,
              minY: frame.y,
              maxX: frame.x + frame.width,
              maxY: frame.y + frame.height,
            };
        const elements = visible.filter(
          (e) => e.id !== frame.id && intersects(bounds(e), b),
        );
        targets.push({
          pageId: p.id,
          title: frame.text || frame.name || p.title,
          frame,
          elements,
          b,
          empty: !elements.length,
        });
      }
      continue;
    }
    let b: Bounds;
    if (scope === "region") {
      const r = request.region;
      if (!r || ![r.x, r.y].every(Number.isFinite))
        throw new ExportError("REGION", "Задайте координаты области экспорта.");
      positive(r.width, "Ширина области");
      positive(r.height, "Высота области");
      b = { minX: r.x, minY: r.y, maxX: r.x + r.width, maxY: r.y + r.height };
      content = content.filter((e) => intersects(bounds(e), b));
    } else {
      const contentBounds = unionBounds(content);
      if (!contentBounds && !["pages", "workspace"].includes(scope))
        throw new ExportError(
          "EMPTY_PAGE",
          "Добавьте объекты на страницу или выберите область экспорта.",
        );
      b = contentBounds
        ? expanded(contentBounds, padding)
        : { minX: 0, minY: 0, maxX: 800, maxY: 600 };
      if (!contentBounds)
        warnings.push(`«${p.title}»: пустая страница 800 × 600.`);
    }
    targets.push({
      pageId: p.id,
      title: p.title,
      elements: content,
      b,
      ids: ids ? content.map((e) => e.id) : undefined,
      empty: !content.length,
    });
  }
  if (!targets.length)
    throw new ExportError(
      "NO_FRAMES",
      "На выбранных страницах нет видимых фреймов.",
    );
  if (
    scope === "frames" &&
    request.frameIds &&
    (new Set(request.frameIds).size !== request.frameIds.length ||
      request.frameIds.some((id) => !targets.some((t) => t.frame?.id === id)))
  )
    throw new ExportError(
      "FRAME_NOT_FOUND",
      "Один из выбранных фреймов не найден, повторяется или скрыт.",
    );
  if (request.format === "svg" && targets.length > 1)
    throw new ExportError(
      "SVG_SINGLE",
      "Для SVG выберите одну страницу, фрейм или область. Для всего пространства доступны PNG, PDF и ZIP.",
    );
  const raster = request.format === "png" || request.format === "zip";
  const pages: ExportPagePlan[] = targets.map((t, i) => {
    const width = Math.max(1, t.b.maxX - t.b.minX),
      height = Math.max(1, t.b.maxY - t.b.minY);
    const size = raster
      ? pixelSize(
          width,
          height,
          request.format === "png" && targets.length > 1
            ? { ...request, pixelWidth: undefined, pixelHeight: undefined }
            : request,
        )
      : { width: Math.ceil(width), height: Math.ceil(height) };
    const pdf =
      request.format === "pdf"
        ? pdfDimensions(width, height, request.pdfPageSize)
        : { width, height };
    const estimatedVectorBytes = vectorEstimate(t.elements);
    if (estimatedVectorBytes > EXPORT_LIMITS.svgBytes)
      throw new ExportError(
        "SVG_LIMIT",
        "Одна область слишком сложна для безопасного экспорта (64 MiB SVG). Разделите её на фреймы или выберите меньшую область.",
      );
    return {
      id: t.frame?.id ?? t.pageId,
      pageId: t.pageId,
      title: t.title,
      filename: `${String(i + 1).padStart(Math.max(3, String(targets.length).length), "0")} - ${safeExportName(t.title)}.png`,
      frameId: t.frame?.id,
      ids: t.ids,
      bounds: t.b,
      width,
      height,
      pixelWidth: size.width,
      pixelHeight: size.height,
      x: 0,
      y: 0,
      pdfWidth: pdf.width,
      pdfHeight: pdf.height,
      estimatedVectorBytes,
      empty: t.empty,
    };
  });
  let width: number | undefined, height: number | undefined;
  if (request.format === "png" && pages.length > 1) {
    const columns =
      request.layout?.columns ?? Math.ceil(Math.sqrt(pages.length));
    positive(columns, "Количество колонок", true);
    if (columns > pages.length)
      throw new ExportError(
        "COLUMNS",
        "Колонок не должно быть больше, чем страниц.",
      );
    const gap = request.layout?.gap ?? 48;
    if (!Number.isFinite(gap) || gap < 0 || gap > 10_000)
      throw new ExportError("GAP", "Интервал должен быть от 0 до 10 000.");
    const rows = Math.ceil(pages.length / columns);
    const widths = Array.from({ length: columns }, () => 0),
      heights = Array.from({ length: rows }, () => 0);
    pages.forEach((p, i) => {
      widths[i % columns] = Math.max(widths[i % columns], p.width);
      heights[Math.floor(i / columns)] = Math.max(
        heights[Math.floor(i / columns)],
        p.height,
      );
    });
    const naturalW = widths.reduce((a, b) => a + b, 0) + gap * (columns - 1);
    const naturalH = heights.reduce((a, b) => a + b, 0) + gap * (rows - 1);
    const size = pixelSize(naturalW, naturalH, request);
    width = size.width;
    height = size.height;
    const sx = width / naturalW,
      sy = height / naturalH;
    const colX: number[] = [],
      rowY: number[] = [];
    widths.forEach((_, i) =>
      colX.push(i ? colX[i - 1] + widths[i - 1] + gap : 0),
    );
    heights.forEach((_, i) =>
      rowY.push(i ? rowY[i - 1] + heights[i - 1] + gap : 0),
    );
    pages.forEach((p, i) => {
      p.x = Math.round(colX[i % columns] * sx);
      p.y = Math.round(rowY[Math.floor(i / columns)] * sy);
      p.pixelWidth = Math.max(
        1,
        Math.round((colX[i % columns] + p.width) * sx) - p.x,
      );
      p.pixelHeight = Math.max(
        1,
        Math.round((rowY[Math.floor(i / columns)] + p.height) * sy) - p.y,
      );
    });
  } else if (request.format === "png") {
    width = pages[0].pixelWidth;
    height = pages[0].pixelHeight;
  }
  if (raster)
    for (const page of pages) checkRaster(page.pixelWidth, page.pixelHeight);
  if (width !== undefined && height !== undefined) checkRaster(width, height);
  const maxPixels = pages.reduce(
    (max, p) => Math.max(max, p.pixelWidth * p.pixelHeight),
    0,
  );
  const vectorBytes = pages.reduce((a, p) => a + p.estimatedVectorBytes, 0);
  if (request.format === "pdf" && vectorBytes > EXPORT_LIMITS.outputBytes)
    throw new ExportError(
      "PDF_BUDGET",
      "Ожидаемый объём PDF превышает 256 MiB. Экспортируйте часть страниц или фреймов.",
    );
  const largestSvg = pages.reduce(
    (max, p) => Math.max(max, p.estimatedVectorBytes),
    0,
  );
  const estimatedWorkingBytes = raster
    ? maxPixels * 12 +
      (pages.length > 1 && request.format === "png"
        ? width! * height! * 4
        : 0) +
      largestSvg * 3 +
      32 * 1024 * 1024
    : (request.format === "pdf" ? vectorBytes * 3 : largestSvg * 4) +
      32 * 1024 * 1024;
  if (estimatedWorkingBytes > EXPORT_LIMITS.workingBytes)
    throw new ExportError(
      "MEMORY_BUDGET",
      "Оценка памяти превышает 1 GiB. Выберите меньшую область, масштаб или отдельные страницы.",
    );
  if (request.format === "zip")
    warnings.push(
      "PNG создаются последовательно. Архив ограничен 256 MiB; при превышении экспорт остановится без снижения качества.",
    );
  return {
    format: request.format,
    extension: request.format,
    mime: mime[request.format],
    title: snapshot.document.title,
    pages,
    width,
    height,
    estimatedWorkingBytes,
    totalPixels:
      width !== undefined && height !== undefined
        ? width * height
        : pages.reduce((a, p) => a + p.pixelWidth * p.pixelHeight, 0),
    transparent: request.transparent === true,
    warnings,
    limits: EXPORT_LIMITS,
  };
}
