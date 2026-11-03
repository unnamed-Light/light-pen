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
export async function exportSvg(
  doc: BoardDocument,
  options: { ids?: Set<string>; frameId?: string; embedFonts?: boolean } = {},
): Promise<VectorPage> {
  const fontData = await fonts();
  const frame = options.frameId
    ? doc.elements.find((e) => e.id === options.frameId && e.kind === "frame")
    : null;
  const elements = doc.elements.filter(
    (e) =>
      !e.hidden &&
      (!options.ids?.size || options.ids.has(e.id)) &&
      (!frame || (e.id !== frame.id && intersects(bounds(e), bounds(frame)))),
  );
  const b: Bounds | null = frame
    ? frame.rotation
      ? bounds(frame)
      : {
          minX: frame.x,
          minY: frame.y,
          maxX: frame.x + frame.width,
          maxY: frame.y + frame.height,
        }
    : unionBounds(elements);
  if (!b) throw new Error("Добавьте объекты перед экспортом.");
  const margin = frame ? 0 : 24,
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
  const body = await Promise.all(
    elements.map(async (el) => {
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
            text(
              el.label,
              p.x,
              p.y + size * 0.34,
              size,
              el.color,
              el,
              "middle",
            );
        }
      } else if (el.kind === "rectangle")
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
      else if (el.kind === "image")
        s = `<image width="${el.width}" height="${el.height}" preserveAspectRatio="none" href="${el.dataUrl}"/>`;
      else if (el.kind === "math") {
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
        if (el.kind === "sticky")
          s += rect(
            0,
            0,
            el.width,
            el.height,
            el.fill === "transparent" ? "#fff1a8" : el.fill,
            "none",
            1,
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
            text(
              el.link?.path || "Объект этой доски",
              16,
              62,
              12,
              "#242424",
              el,
            );
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
            el.kind === "sticky" ? 20 : el.kind === "frame" ? 10 : 0;
          ctx.font = `${el.italic ? "italic " : ""}${el.bold ? "700 " : ""}${size}px LightPenExport`;
          const lines = wrapText(
            ctx,
            el.text ?? "",
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
                el.kind === "sticky" ? "#242424" : el.color,
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
      return `<g opacity="${el.opacity}" transform="translate(${n(el.x)} ${n(el.y)}) rotate(${el.rotation ?? 0} ${n(localC.x)} ${n(localC.y)})">${s}</g>`;
    }),
  );
  const style =
    options.embedFonts === false
      ? ""
      : `<style>${fontData.map((f) => `@font-face{font-family:LightPenExport;src:url(data:font/ttf;base64,${f.data});font-weight:${f.style.includes("Bold") ? 700 : 400};font-style:${f.style.includes("Italic") ? "italic" : "normal"}}`).join("")}</style>`;
  const fc = frame ? rotationCenter(frame) : null;
  const clipped = frame
    ? `<defs><clipPath id="lpFrame"><rect x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}" transform="rotate(${frame.rotation ?? 0} ${fc!.x} ${fc!.y})"/></clipPath></defs><g clip-path="url(#lpFrame)">${body.join("")}</g>`
    : body.join("");
  return {
    width: w,
    height: h,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${n(w)}" height="${n(h)}" viewBox="${n(b.minX - margin)} ${n(b.minY - margin)} ${n(w)} ${n(h)}" stroke-linecap="round" stroke-linejoin="round"><title>${xml(doc.title)}</title>${style}${rect(b.minX - margin, b.minY - margin, w, h, "#ffffff")}${clipped}</svg>`,
  };
}
export async function exportPdf(
  doc: BoardDocument,
  options: { ids?: Set<string>; frames?: SceneElement[] } = {},
): Promise<Uint8Array> {
  const [{ jsPDF }, fontData] = await Promise.all([import("jspdf"), fonts()]);
  await import("svg2pdf.js");
  const pages = options.frames?.length
    ? options.frames.map((f) => f.id)
    : [undefined];
  let pdf: InstanceType<typeof jsPDF> | undefined;
  for (const frameId of pages) {
    const page = await exportSvg(doc, {
      ids: frameId ? undefined : options.ids,
      frameId,
      embedFonts: false,
    });
    const scale = Math.min(1, 14000 / Math.max(page.width, page.height)),
      w = page.width * scale,
      h = page.height * scale;
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
    const host = document.createElement("div");
    host.style.cssText =
      "position:fixed;left:-100000px;top:0;pointer-events:none";
    host.append(node);
    document.body.append(host);
    try {
      await pdf.svg(node as unknown as SVGElement, {
        x: 0,
        y: 0,
        width: w,
        height: h,
      });
    } finally {
      host.remove();
    }
  }
  pdf!.setProperties({ title: doc.title, creator: "Light Pen" });
  return new Uint8Array(pdf!.output("arraybuffer"));
}
