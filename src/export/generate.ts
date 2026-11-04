import { Zip, ZipPassThrough } from "fflate";
import { pageDocument } from "../editor/model/pages";
import { exportPdfPages, exportSvg } from "../editor/render/vector-export";
import type { PdfPageSource } from "../editor/render/vector-export";
import type { SvgExportOptions } from "../editor/render/vector-export";
import { EXPORT_LIMITS, ExportError, planExport } from "./plan";
import type {
  ExportPagePlan,
  ExportPlan,
  ExportRequest,
  ExportSnapshot,
} from "./plan";

export interface ExportProgress {
  phase: "rendering" | "packing" | "complete";
  completed: number;
  total: number;
  title?: string;
}
export interface ExportGenerationOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ExportProgress) => void;
}
export interface GeneratedExport {
  blob: Blob;
  extension: ExportPlan["extension"];
  mime: string;
  width?: number;
  height?: number;
  pages: number;
  documentId: string;
  revision: number;
  plan: ExportPlan;
}

function check(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Экспорт отменён.", "AbortError");
}
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function svgOptions(
  page: ExportPagePlan,
  plan: ExportPlan,
  signal?: AbortSignal,
): SvgExportOptions {
  return {
    ids: page.ids ? new Set(page.ids) : undefined,
    frameId: page.frameId,
    bounds: page.bounds,
    padding: 0,
    transparent: plan.transparent,
    signal,
    maxBytes: EXPORT_LIMITS.svgBytes,
  };
}

function canvas(width: number, height: number, transparent: boolean) {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  const context = element.getContext("2d", { alpha: true });
  if (!context)
    throw new ExportError(
      "CANVAS",
      "Не удалось выделить память для изображения. Выберите меньший размер.",
    );
  if (!transparent) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
  }
  return { element, context };
}

async function pngBlob(element: HTMLCanvasElement, signal?: AbortSignal) {
  check(signal);
  const blob = await new Promise<Blob>((resolve, reject) => {
    element.toBlob(
      (result) =>
        result
          ? resolve(result)
          : reject(
              new ExportError(
                "PNG",
                "Не удалось создать PNG. Выберите меньший размер.",
              ),
            ),
      "image/png",
    );
  });
  check(signal);
  if (blob.size > EXPORT_LIMITS.outputBytes)
    throw new ExportError(
      "OUTPUT_LIMIT",
      "Файл превышает 256 MiB. Выберите меньшую область или масштаб.",
    );
  return blob;
}

async function drawSvg(
  context: CanvasRenderingContext2D,
  svg: string,
  x: number,
  y: number,
  width: number,
  height: number,
  signal?: AbortSignal,
) {
  check(signal);
  // Intrinsic SVG dimensions must match the intended bitmap, not a potentially
  // enormous infinite-canvas extent. The viewBox preserves document coordinates.
  const sized = svg.replace(/^<svg\b[^>]*>/, (tag) =>
    tag
      .replace(/\bwidth="[^"]*"/, `width="${Math.max(1, Math.ceil(width))}"`)
      .replace(
        /\bheight="[^"]*"/,
        `height="${Math.max(1, Math.ceil(height))}"`,
      ),
  );
  const url = URL.createObjectURL(new Blob([sized], { type: "image/svg+xml" }));
  const image = new Image();
  let abort: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        image.onload = image.onerror = null;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", abort!);
        error ? reject(error) : resolve();
      };
      abort = () => finish(new DOMException("Экспорт отменён.", "AbortError"));
      image.onload = () => finish();
      image.onerror = () =>
        finish(
          new ExportError(
            "RASTERIZE",
            "Не удалось отрисовать содержимое страницы. Проверьте изображения и формулы.",
          ),
        );
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(
        () =>
          finish(
            new ExportError(
              "RASTERIZE_TIMEOUT",
              "Страница слишком долго готовится. Попробуйте меньшую область.",
            ),
          ),
        60_000,
      );
      image.src = url;
      if (signal?.aborted) abort();
    });
    check(signal);
    context.drawImage(image, x, y, width, height);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener("abort", abort!);
    image.onload = image.onerror = null;
    image.src = "";
    URL.revokeObjectURL(url);
  }
}

async function pageSvg(
  snapshot: ExportSnapshot,
  page: ExportPagePlan,
  plan: ExportPlan,
  signal?: AbortSignal,
) {
  check(signal);
  return exportSvg(
    pageDocument(snapshot.document, page.pageId),
    svgOptions(page, plan, signal),
  );
}

async function renderPng(
  snapshot: ExportSnapshot,
  plan: ExportPlan,
  pages: ExportPagePlan[],
  width: number,
  height: number,
  options: ExportGenerationOptions,
) {
  const { element, context } = canvas(width, height, plan.transparent);
  try {
    for (let i = 0; i < pages.length; i++) {
      check(options.signal);
      const page = pages[i];
      const source = await pageSvg(snapshot, page, plan, options.signal);
      await drawSvg(
        context,
        source.svg,
        page.x,
        page.y,
        page.pixelWidth,
        page.pixelHeight,
        options.signal,
      );
      options.onProgress?.({
        phase: "rendering",
        completed: i + 1,
        total: pages.length,
        title: page.title,
      });
      await pause();
    }
    return await pngBlob(element, options.signal);
  } finally {
    // Release the backing store before starting another page or handing off
    // encoded bytes. A ZIP never holds all uncompressed page canvases at once.
    element.width = 0;
    element.height = 0;
  }
}

async function archive(
  snapshot: ExportSnapshot,
  plan: ExportPlan,
  options: ExportGenerationOptions,
): Promise<Blob> {
  const parts: BlobPart[] = [];
  let outputBytes = 0,
    failure: Error | undefined;
  let finished = false;
  const zip = new Zip((error, data, final) => {
    if (error) {
      failure = error;
      return;
    }
    if (failure) return;
    outputBytes += data.byteLength;
    if (outputBytes > EXPORT_LIMITS.outputBytes) {
      failure = new ExportError(
        "ZIP_LIMIT",
        "Архив превышает 256 MiB. Экспортируйте часть страниц или уменьшите масштаб. Качество не изменено автоматически.",
      );
      zip.terminate();
      return;
    }
    parts.push(data.slice().buffer as ArrayBuffer);
    finished = final;
  });
  const append = async (name: string, blob: Blob) => {
    const file = new ZipPassThrough(name);
    zip.add(file);
    const reader = blob.stream().getReader();
    try {
      while (true) {
        check(options.signal);
        if (failure) throw failure;
        const { value, done } = await reader.read();
        if (done) break;
        // PNG is already compressed; passthrough avoids recompression and its
        // additional buffers. CRC and ZIP headers are streamed by fflate.
        file.push(value, false);
      }
      file.push(new Uint8Array(), true);
      if (failure) throw failure;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  };
  try {
    for (let i = 0; i < plan.pages.length; i++) {
      check(options.signal);
      const page = plan.pages[i];
      const blob = await renderPng(
        snapshot,
        plan,
        [{ ...page, x: 0, y: 0 }],
        page.pixelWidth,
        page.pixelHeight,
        { signal: options.signal },
      );
      await append(page.filename, blob);
      options.onProgress?.({
        phase: "packing",
        completed: i + 1,
        total: plan.pages.length,
        title: page.title,
      });
      await pause();
    }
    await append(
      "light-pen-export.json",
      new Blob(
        [
          JSON.stringify(
            {
              title: plan.title,
              documentId: snapshot.document.id,
              revision: snapshot.document.revision,
              pages: plan.pages.map((p) => ({
                id: p.id,
                pageId: p.pageId,
                title: p.title,
                file: p.filename,
                width: p.pixelWidth,
                height: p.pixelHeight,
              })),
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      ),
    );
    zip.end();
    if (failure) throw failure;
    if (!finished) throw new ExportError("ZIP", "Не удалось завершить архив.");
    check(options.signal);
    return new Blob(parts, { type: plan.mime });
  } catch (error) {
    zip.terminate();
    parts.length = 0;
    throw error;
  }
}

/** Generate from a frozen snapshot. The caller handles a save path and permissions. */
export async function generateExport(
  snapshot: ExportSnapshot,
  input: ExportRequest,
  options: ExportGenerationOptions = {},
): Promise<GeneratedExport> {
  const request = structuredClone(input);
  const plan = planExport(snapshot, request);
  check(options.signal);
  let blob: Blob;
  if (plan.format === "png") {
    blob = await renderPng(
      snapshot,
      plan,
      plan.pages,
      plan.width!,
      plan.height!,
      options,
    );
  } else if (plan.format === "zip") {
    blob = await archive(snapshot, plan, options);
  } else if (plan.format === "svg") {
    const page = await pageSvg(snapshot, plan.pages[0], plan, options.signal);
    blob = new Blob([page.svg], { type: plan.mime });
  } else {
    function* sources(): Generator<PdfPageSource> {
      for (const page of plan.pages)
        yield {
          document: pageDocument(snapshot.document, page.pageId),
          options: svgOptions(page, plan, options.signal),
          width: page.pdfWidth,
          height: page.pdfHeight,
        };
    }
    const bytes = await exportPdfPages(snapshot.document.title, sources(), {
      signal: options.signal,
      maxBytes: EXPORT_LIMITS.outputBytes,
      onProgress: (completed) =>
        options.onProgress?.({
          phase: "rendering",
          completed,
          total: plan.pages.length,
        }),
    });
    blob = new Blob([bytes.buffer as ArrayBuffer], { type: plan.mime });
  }
  check(options.signal);
  if (blob.size > EXPORT_LIMITS.outputBytes)
    throw new ExportError(
      "OUTPUT_LIMIT",
      "Результат превышает 256 MiB. Выберите часть страниц или меньшую область.",
    );
  options.onProgress?.({
    phase: "complete",
    completed: plan.pages.length,
    total: plan.pages.length,
  });
  return {
    blob,
    extension: plan.extension,
    mime: plan.mime,
    width: plan.width,
    height: plan.height,
    pages: plan.pages.length,
    documentId: snapshot.document.id,
    revision: snapshot.document.revision,
    plan,
  };
}

/** Preview is intentionally reduced; it never changes requested export dimensions. */
export async function renderExportPreview(
  snapshot: ExportSnapshot,
  request: ExportRequest,
  options: { signal?: AbortSignal; maxSide?: number; pageIndex?: number } = {},
): Promise<{
  blob: Blob;
  width: number;
  height: number;
  pageCount: number;
  plan: ExportPlan;
}> {
  const plan = planExport(snapshot, request);
  const index = Math.max(
    0,
    Math.min(plan.pages.length - 1, options.pageIndex ?? 0),
  );
  const mosaic = plan.format === "png" && plan.pages.length > 1;
  const selected = plan.pages[index];
  const width = mosaic ? plan.width! : selected.width,
    height = mosaic ? plan.height! : selected.height;
  const maxSide = Math.max(32, Math.min(1600, options.maxSide ?? 560));
  const factor = Math.min(1, maxSide / Math.max(width, height));
  const previewWidth = Math.max(1, Math.round(width * factor)),
    previewHeight = Math.max(1, Math.round(height * factor));
  const { element, context } = canvas(
    previewWidth,
    previewHeight,
    plan.transparent,
  );
  try {
    for (const page of mosaic ? plan.pages : [selected]) {
      const source = await pageSvg(snapshot, page, plan, options.signal);
      await drawSvg(
        context,
        source.svg,
        mosaic ? page.x * factor : 0,
        mosaic ? page.y * factor : 0,
        mosaic ? page.pixelWidth * factor : previewWidth,
        mosaic ? page.pixelHeight * factor : previewHeight,
        options.signal,
      );
    }
    return {
      blob: await pngBlob(element, options.signal),
      width: previewWidth,
      height: previewHeight,
      pageCount: plan.pages.length,
      plan,
    };
  } finally {
    element.width = 0;
    element.height = 0;
  }
}
