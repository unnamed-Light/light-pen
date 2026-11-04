import { getStroke } from "perfect-freehand";
import type { BoardDocument, Bounds, SceneElement } from "../model/types";
import {
  bounds,
  intersects,
  rotationCenter,
  unionBounds,
} from "../model/geometry";
import { connectorMidpoint, connectorPoints } from "../model/connectors";
import { wrapText } from "./renderer";
import { STATUS_TEXT } from "./structured";

const xml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
const n = (v: number) => Number(v.toFixed(3));
let fontPromise: Promise<{ style: string; data: string }[]> | undefined;
async function fonts() {
  return (fontPromise ??= Promise.all(
    ["Regular", "Bold", "Italic", "BoldItalic"].map(async (style) => {
      const response = await fetch(`/fonts/NotoSans-${style}.ttf`);
      if (!response.ok) throw new Error("Не удалось загрузить шрифт экспорта.");
      const blob = await response.blob();
      const data = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result).split(",")[1]);
        r.onerror = reject;
        r.readAsDataURL(blob);
      });
      const face = new FontFace(
        "LightPenExport",
        `url(data:font/ttf;base64,${data})`,
        {
          weight: style.includes("Bold") ? "700" : "400",
          style: style.includes("Italic") ? "italic" : "normal",
        },
      );
      await face.load();
      document.fonts.add(face);
      return { style, data };
    }),
  ));
}
export interface VectorPage {
  svg: string;
  width: number;
  height: number;
}
export interface SvgExportOptions {
  ids?: Set<string>;
  frameId?: string;
  embedFonts?: boolean;
  bounds?: Bounds;
  padding?: number;
  transparent?: boolean;
  signal?: AbortSignal;
  maxBytes?: number;
}
function checkAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Экспорт отменён.", "AbortError");
}
async function verifyImage(data: string | undefined, signal?: AbortSignal) {
  if (!data || !/^data:image\/(png|jpeg|webp);base64,/i.test(data))
    throw new Error("Не удалось загрузить изображение для экспорта.");
  checkAborted(signal);
  const image = new Image();
  let abort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        image.onload = image.onerror = null;
        signal?.removeEventListener("abort", abort!);
        error ? reject(error) : resolve();
      };
      abort = () => finish(new DOMException("Экспорт отменён.", "AbortError"));
      image.onload = () =>
        image.naturalWidth > 0 &&
        image.naturalHeight > 0 &&
        image.naturalWidth * image.naturalHeight <= 32_000_000
          ? finish()
          : finish(new Error("Изображение превышает 32 Мп или повреждено."));
      image.onerror = () =>
        finish(new Error("Не удалось загрузить изображение для экспорта."));
      signal?.addEventListener("abort", abort, { once: true });
      image.src = data;
      if (signal?.aborted) abort();
    });
  } finally {
    image.onload = image.onerror = null;
    signal?.removeEventListener("abort", abort!);
    image.src = "";
  }
}
export async function exportSvg(
  doc: BoardDocument,
  options: SvgExportOptions = {},
): Promise<VectorPage> {
  checkAborted(options.signal);
  const fontData = await fonts();
  checkAborted(options.signal);
  const frame = options.frameId
    ? doc.elements.find(
        (e) => e.id === options.frameId && e.kind === "frame" && !e.hidden,
      )
    : null;
  if (options.frameId && !frame)
    throw new Error("Фрейм для экспорта не найден или скрыт.");
  const elements = doc.elements.filter(
    (e) =>
      !e.hidden &&
      (!options.ids || options.ids.has(e.id)) &&
      (!frame || (e.id !== frame.id && intersects(bounds(e), bounds(frame)))) &&
      (!options.bounds || intersects(bounds(e), options.bounds)),
  );
  const b: Bounds | null =
    options.bounds ??
    (frame
      ? frame.rotation
        ? bounds(frame)
        : {
            minX: frame.x,
            minY: frame.y,
            maxX: frame.x + frame.width,
            maxY: frame.y + frame.height,
          }
      : unionBounds(elements));
  if (!b) throw new Error("Добавьте объекты перед экспортом.");
  const margin = options.bounds ? 0 : (options.padding ?? (frame ? 0 : 24)),
    w = Math.max(1, b.maxX - b.minX + margin * 2),
    h = Math.max(1, b.maxY - b.minY + margin * 2);
  const ctx = document.createElement("canvas").getContext("2d")!;
  let index = 0;
  const rect = (
    x: number,
    y: number,
    w: number,
    h: number,
    fill: string,
    stroke = "none",
    sw = 1,
    rx = 0,
  ) =>
    `<rect x="${n(x)}" y="${n(y)}" width="${n(Math.max(0, w))}" height="${n(Math.max(0, h))}" rx="${rx}" fill="${fill === "transparent" ? "none" : fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
  const text = (
    value: string,
    x: number,
    y: number,
    size: number,
    color: string,
    el: SceneElement,
    anchor = "start",
  ) =>
    `<text x="${n(x)}" y="${n(y)}" font-family="LightPenExport" font-size="${n(size)}" font-weight="${el.bold ? 700 : 400}" font-style="${el.italic ? "italic" : "normal"}" text-anchor="${anchor}" fill="${color}">${xml(value)}</text>`;
  const body: string[] = [];
  let bodyBytes = 0;
  const byteCounter = new TextEncoder();
  for (const el of elements) {
    checkAborted(options.signal);
    const size = el.fontSize ?? 18,
      c = rotationCenter(el),
      localC = { x: c.x - el.x, y: c.y - el.y };
    let s = "";
    const clip = `lp${index++}`;
    if (el.kind === "stroke") {
      const pts = getStroke(
        el.points!.map((p) => p.slice(0, 3)),
        {
          size: el.strokeWidth,
          thinning: 1 - (el.ink?.minWidth ?? 40) / 100,
          smoothing: (el.ink?.smoothing ?? 60) / 100,
          streamline: (el.ink?.stabilization ?? 12) / 100,
          simulatePressure: false,
          last: true,
        },
      );
      if (pts.length)
        s = `<path fill="${el.color}" d="M${pts[0].map(n).join(" ")} ${pts
          .map((p, i) => {
            const q = pts[(i + 1) % pts.length];
            return `Q${p.map(n).join(" ")} ${n((p[0] + q[0]) / 2)} ${n((p[1] + q[1]) / 2)}`;
          })
          .join(" ")} Z"/>`;
    } else if (el.kind === "arrow" || el.kind === "line") {
      const pts = connectorPoints(el),
        end = pts.at(-1)!,
        prev = pts.at(-2) ?? { x: 0, y: 0 },
        a = Math.atan2(end.y - prev.y, end.x - prev.x),
        len = Math.max(10, el.strokeWidth * 3.5);
      s = `<polyline points="${pts.map((p) => `${n(p.x)},${n(p.y)}`).join(" ")}" fill="none" stroke="${el.color}" stroke-width="${el.strokeWidth}"/>`;
      if (el.kind === "arrow")
        s += `<polyline fill="none" stroke="${el.color}" stroke-width="${el.strokeWidth}" points="${n(end.x - Math.cos(a - 0.48) * len)},${n(end.y - Math.sin(a - 0.48) * len)} ${n(end.x)},${n(end.y)} ${n(end.x - Math.cos(a + 0.48) * len)},${n(end.y - Math.sin(a + 0.48) * len)}"/>`;
      if (el.label) {
        const p = connectorMidpoint(el);
        ctx.font = `${size}px LightPenExport`;
        const tw = Math.min(800, ctx.measureText(el.label).width + 16);
        s +=
          rect(p.x - tw / 2, p.y - size * 0.7, tw, size * 1.4, "#ffffff") +
          text(el.label, p.x, p.y + size * 0.34, size, el.color, el, "middle");
      }
    } else if (el.kind === "rectangle" && !el.widget)
      s = rect(
        0,
        0,
        el.width,
        el.height,
        el.fill,
        el.color,
        el.strokeWidth,
        Math.min(8, el.width / 2, el.height / 2),
      );
    else if (el.kind === "ellipse")
      s = `<ellipse cx="${el.width / 2}" cy="${el.height / 2}" rx="${el.width / 2}" ry="${el.height / 2}" fill="${el.fill === "transparent" ? "none" : el.fill}" stroke="${el.color}" stroke-width="${el.strokeWidth}"/>`;
    else if (el.kind === "diamond")
      s = `<polygon points="${el.width / 2},0 ${el.width},${el.height / 2} ${el.width / 2},${el.height} 0,${el.height / 2}" fill="${el.fill === "transparent" ? "none" : el.fill}" stroke="${el.color}" stroke-width="${el.strokeWidth}"/>`;
    else if (el.kind === "image") {
      await verifyImage(el.dataUrl, options.signal);
      s = `<image width="${el.width}" height="${el.height}" preserveAspectRatio="none" href="${xml(el.dataUrl!)}"/>`;
    } else if (el.kind === "math") {
      const { renderFormula } = await import("./math");
      const result = await renderFormula(el.text ?? "", el.color, size);
      const inner = decodeURIComponent(
        result.dataUrl.split(",").slice(1).join(","),
      ).replace(/<svg[^>]+>/, (tag) =>
        tag
          .replace(/width="[^"]+"/, `width="${el.width}"`)
          .replace(/height="[^"]+"/, `height="${el.height}"`),
      );
      s = inner;
    } else {
      s += `<defs><clipPath id="${clip}">${rect(0, 0, el.width, el.height, "#ffffff")}</clipPath></defs><g clip-path="url(#${clip})">`;
      if (el.kind === "sticky" || el.widget)
        s += rect(
          0,
          0,
          el.width,
          el.height,
          el.fill === "transparent" ? "#fff1a8" : el.fill,
          el.widget ? el.color : "none",
          el.widget ? el.strokeWidth : 1,
          4,
        );
      if (["table", "task", "link"].includes(el.kind))
        s += rect(
          0,
          0,
          el.width,
          el.height,
          el.fill === "transparent" ? "#ffffff" : el.fill,
          el.color,
          el.strokeWidth,
          6,
        );
      if (el.kind === "table" && el.cells) {
        const rh = el.height / el.cells.length,
          cw = el.width / el.cells[0].length;
        s += rect(0, 0, el.width, rh, "#e5f0fa");
        el.cells.forEach((row, r) =>
          row.forEach((cell, c) => {
            s += rect(c * cw, r * rh, cw, rh, "transparent", "#c7c7c7", 1);
            const cid = `lp${index++}`;
            s += `<defs><clipPath id="${cid}">${rect(c * cw + 6, r * rh + 2, Math.max(1, cw - 12), Math.max(1, rh - 4), "#ffffff")}</clipPath></defs><g clip-path="url(#${cid})">`;
            const lines = cell.split("\n");
            lines.forEach(
              (v, i) =>
                (s += text(
                  v,
                  c * cw +
                    (el.textAlign === "center"
                      ? cw / 2
                      : el.textAlign === "right"
                        ? cw - 10
                        : 10),
                  r * rh +
                    rh / 2 +
                    size * 0.34 +
                    (i - (lines.length - 1) / 2) * size * 1.2,
                  size,
                  "#242424",
                  { ...el, bold: r === 0 || el.bold },
                  el.textAlign === "center"
                    ? "middle"
                    : el.textAlign === "right"
                      ? "end"
                      : "start",
                )),
            );
            s += "</g>";
          }),
        );
      } else if (el.kind === "task" && el.task) {
        s +=
          text(el.text ?? "Задача", 16, 32, size, "#242424", {
            ...el,
            bold: true,
          }) +
          text(
            STATUS_TEXT[el.task.status] +
              (el.task.due ? ` · до ${el.task.due}` : ""),
            16,
            59,
            12,
            "#0f6cbd",
            el,
          );
        el.task.items.forEach((item, i) => {
          const y = 76 + i * 30;
          s += rect(
            18,
            y + 4,
            16,
            16,
            "transparent",
            item.done ? "#107c50" : "#8a8a8a",
            1.5,
          );
          if (item.done)
            s += `<path d="M21 ${y + 12}l4 4 6 -8" fill="none" stroke="#107c50" stroke-width="1.5"/>`;
          s += text(
            item.text,
            44,
            y + 19,
            Math.min(size, 20),
            item.done ? "#707070" : "#242424",
            el,
          );
        });
      } else if (el.kind === "link")
        s +=
          text(
            "↗ " + (el.link?.label || el.text || "Ссылка"),
            16,
            36,
            size,
            el.color,
            { ...el, bold: true },
          ) +
          text(el.link?.path || "Объект этой доски", 16, 62, 12, "#242424", el);
      else {
        if (el.kind === "frame")
          s +=
            rect(
              0,
              0,
              el.width,
              el.height,
              "transparent",
              el.color,
              el.strokeWidth,
            ) + rect(0, 0, el.width, size * 1.35 + 8, "#ffffff");
        const padding =
          el.kind === "sticky" || el.widget ? 20 : el.kind === "frame" ? 10 : 0;
        ctx.font = `${el.italic ? "italic " : ""}${el.bold ? "700 " : ""}${size}px LightPenExport`;
        const lines = wrapText(
          ctx,
          el.widget?.fallback ?? el.text ?? "",
          Math.max(10, el.width - padding * 2),
        );
        lines.forEach((line, i) => {
          if (padding + i * size * 1.35 < el.height)
            s += text(
              line,
              el.textAlign === "center"
                ? el.width / 2
                : el.textAlign === "right"
                  ? el.width - padding
                  : padding,
              padding + size * 0.82 + i * size * 1.35,
              size,
              el.kind === "sticky" || el.widget ? "#242424" : el.color,
              el,
              el.textAlign === "center"
                ? "middle"
                : el.textAlign === "right"
                  ? "end"
                  : "start",
            );
        });
      }
      s += "</g>";
    }
    const chunk = `<g opacity="${el.opacity}" transform="translate(${n(el.x)} ${n(el.y)}) rotate(${el.rotation ?? 0} ${n(localC.x)} ${n(localC.y)})">${s}</g>`;
    bodyBytes += byteCounter.encode(chunk).length;
    if (bodyBytes > (options.maxBytes ?? 64 * 1024 * 1024))
      throw new Error(
        "SVG превышает безопасный предел 64 MiB. Выберите меньшую область.",
      );
    body.push(chunk);
    if (body.length % 128 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      checkAborted(options.signal);
    }
  }
  const style =
    options.embedFonts === false
      ? ""
      : `<style>${fontData.map((f) => `@font-face{font-family:LightPenExport;src:url(data:font/ttf;base64,${f.data});font-weight:${f.style.includes("Bold") ? 700 : 400};font-style:${f.style.includes("Italic") ? "italic" : "normal"}}`).join("")}</style>`;
  const fc = frame ? rotationCenter(frame) : null;
  const clipped = frame
    ? `<defs><clipPath id="lpFrame"><rect x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}" transform="rotate(${frame.rotation ?? 0} ${fc!.x} ${fc!.y})"/></clipPath></defs><g clip-path="url(#lpFrame)">${body.join("")}</g>`
    : body.join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${n(w)}" height="${n(h)}" viewBox="${n(b.minX - margin)} ${n(b.minY - margin)} ${n(w)} ${n(h)}" stroke-linecap="round" stroke-linejoin="round"><title>${xml(doc.title)}</title>${style}${options.transparent ? "" : rect(b.minX - margin, b.minY - margin, w, h, "#ffffff")}${clipped}</svg>`;
  if (byteCounter.encode(svg).length > (options.maxBytes ?? 64 * 1024 * 1024))
    throw new Error(
      "SVG превышает безопасный предел 64 MiB. Выберите меньшую область.",
    );
  return {
    width: w,
    height: h,
    svg,
  };
}
export interface PdfPageSource {
  document: BoardDocument;
  options?: SvgExportOptions;
  width?: number;
  height?: number;
}
/** Each SVG is generated and released before the next page is prepared. */
export async function exportPdfPages(
  title: string,
  pages: Iterable<PdfPageSource>,
  options: {
    signal?: AbortSignal;
    maxBytes?: number;
    onProgress?: (done: number) => void;
  } = {},
): Promise<Uint8Array> {
  checkAborted(options.signal);
  const [{ jsPDF }, fontData] = await Promise.all([import("jspdf"), fonts()]);
  await import("svg2pdf.js");
  let pdf: InstanceType<typeof jsPDF> | undefined;
  let vectorBytes = 0,
    completed = 0;
  const maxBytes = options.maxBytes ?? 256 * 1024 * 1024;
  for (const source of pages) {
    checkAborted(options.signal);
    const page = await exportSvg(source.document, {
      ...source.options,
      embedFonts: false,
      signal: options.signal,
    });
    vectorBytes += new TextEncoder().encode(page.svg).length;
    if (vectorBytes > maxBytes)
      throw new Error(
        "PDF превышает безопасный объём 256 MiB. Выберите часть страниц.",
      );
    const w = source.width ?? page.width,
      h = source.height ?? page.height;
    if (![w, h].every((v) => Number.isFinite(v) && v > 0 && v <= 14000))
      throw new Error(
        "Размер страницы PDF должен быть от 1 до 14 000 pt; выберите A4/A3 или меньшую область.",
      );
    if (!pdf) {
      pdf = new jsPDF({
        unit: "pt",
        format: [w, h],
        orientation: w > h ? "landscape" : "portrait",
        compress: true,
        putOnlyUsedFonts: true,
      });
      for (const f of fontData) {
        const filename = `NotoSans-${f.style}.ttf`;
        pdf.addFileToVFS(filename, f.data);
        pdf.addFont(
          filename,
          "LightPenExport",
          f.style === "Regular" ? "normal" : f.style.toLowerCase(),
        );
      }
    } else pdf.addPage([w, h], w > h ? "landscape" : "portrait");
    const node = new DOMParser().parseFromString(
      page.svg,
      "image/svg+xml",
    ).documentElement;
    if (node.localName === "parsererror" || node.querySelector("parsererror"))
      throw new Error("Не удалось подготовить SVG для PDF.");
    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;left:-100000px;top:0;pointer-events:none";
    host.append(node);
    document.body.append(host);
    try {
      const scale = Math.min(w / page.width, h / page.height);
      const width = page.width * scale,
        height = page.height * scale;
      await pdf.svg(node as unknown as SVGElement, {
        x: (w - width) / 2,
        y: (h - height) / 2,
        width,
        height,
      });
    } finally {
      host.remove();
    }
    checkAborted(options.signal);
    options.onProgress?.(++completed);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  if (!pdf) throw new Error("Нет страниц для PDF.");
  pdf.setProperties({ title, creator: "Light Pen" });
  const bytes = new Uint8Array(pdf.output("arraybuffer"));
  if (bytes.byteLength > maxBytes)
    throw new Error(
      "PDF превышает безопасный объём 256 MiB. Выберите часть страниц.",
    );
  return bytes;
}
export async function exportPdf(
  doc: BoardDocument,
  options: { ids?: Set<string>; frames?: SceneElement[] } = {},
): Promise<Uint8Array> {
  const pages = options.frames?.length
    ? options.frames.map((f) => f.id)
    : [undefined];
  return exportPdfPages(
    doc.title,
    pages.map((frameId) => ({
      document: doc,
      options: { ids: frameId ? undefined : options.ids, frameId },
    })),
  );
}
