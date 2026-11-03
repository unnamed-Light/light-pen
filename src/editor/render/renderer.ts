import { getStroke } from "perfect-freehand";
import type { Editor, Signal } from "../editor";
import {
  bounds,
  intersects,
  unionBounds,
  rotationCenter,
  rotatePoint,
} from "../model/geometry";
import { connectorPoints, connectorMidpoint } from "../model/connectors";
import { drawStructured } from "./structured";
import type { InkPoint, RenderStats, SceneElement } from "../model/types";

const INK_BLOCK = 256,
  INK_TAIL = 512,
  INK_OVERLAP = 16;
interface InkCache {
  first: InkPoint;
  last: InkPoint | undefined;
  width: number;
  consumed: number;
  chunks: Path2D[];
  tail: Path2D;
  count: number;
  finalPath?: Path2D;
  finalCount?: number;
  finalLast?: InkPoint;
}

export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(/(\s+)/)) {
      if (ctx.measureText(line + word).width <= maxWidth) {
        line += word;
        continue;
      }
      if (line.trim()) lines.push(line.trimEnd());
      line = "";
      if (ctx.measureText(word).width <= maxWidth) {
        line = word.trimStart();
        continue;
      }
      for (const char of word) {
        if (line && ctx.measureText(line + char).width > maxWidth) {
          lines.push(line);
          line = "";
        }
        line += char;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

export class BoardRenderer {
  lastPhases = { drawingMs: 0, rasterMs: 0 };

  dark = false;
  stats: RenderStats = {
    mainFrames: 0,
    overlayFrames: 0,
    lastMs: 0,
    lastOverlayMs: 0,
    visible: 0,
    cachedPaths: 0,
    inkTailPoints: 0,
    samples: [],
    overlaySamples: [],
  };
  private main: CanvasRenderingContext2D;
  private overlay: CanvasRenderingContext2D;
  private frame = 0;
  private mainDirty = true;
  private overlayDirty = true;
  private ratio = 1;
  private width = 1;
  private height = 1;
  private inkId = "";
  private inkPaintedChunks = 0;
  private inkCamera = "";
  private inkBase = document.createElement("canvas");
  private inkBaseContext = this.inkBase.getContext("2d")!;
  private paths = new Map<string, InkCache>();

  private documentId = "";
  private sceneRaster: {
    canvas: HTMLCanvasElement;
    elements: SceneElement[];
    x: number;
    y: number;
    zoom: number;
    dark: boolean;
    grid: boolean;
  } | null = null;
  private textLayouts = new WeakMap<SceneElement, string[]>();
  private images = new Map<
    string,
    {
      data: string;
      image: HTMLImageElement;
      ready: Promise<void>;
      elementId: string;
      error: string;
    }
  >();
  private unsubscribe: () => void;
  private disposed = false;
  constructor(
    private editor: Editor,
    private canvas: HTMLCanvasElement,
    private overlayCanvas: HTMLCanvasElement,
  ) {
    this.main = canvas.getContext("2d", { alpha: false })!;
    this.overlay = overlayCanvas.getContext("2d")!;
    editor.measureTextLines = (text, fontSize, width, style) => {
      this.main.save();
      this.main.font = `${style?.italic ? "italic " : ""}${style?.bold ? "700 " : ""}${fontSize}px "Segoe UI", sans-serif`;
      const count = wrapText(this.main, text, width).length;
      this.main.restore();
      return count;
    };
    this.unsubscribe = editor.subscribe(this.onSignal);
    this.request();
  }
  private onSignal = (s: Signal) => {
    if (this.documentId !== this.editor.document.id) {
      this.documentId = this.editor.document.id;
      this.paths.clear();
      this.images.clear();
      this.textLayouts = new WeakMap();
      this.inkId = "";
      this.clearRaster();
    }
    if (s === "document" || s === "scene" || s === "camera")
      this.mainDirty = true;
    this.overlayDirty = true;
    this.request();
  };
  dispose() {
    this.disposed = true;

    cancelAnimationFrame(this.frame);
    this.unsubscribe();
    this.editor.measureTextLines = null;
    this.paths.clear();
    this.images.clear();
    this.clearRaster();
  }
  resize(width: number, height: number) {
    const ratio = Math.min(3, window.devicePixelRatio || 1);
    if (width === this.width && height === this.height && ratio === this.ratio)
      return;
    this.width = width;
    this.height = height;
    this.ratio = ratio;
    for (const canvas of [this.canvas, this.overlayCanvas, this.inkBase]) {
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
    }
    this.editor.viewport = { width, height };
    this.inkId = "";
    this.clearRaster();
    this.mainDirty = true;
    this.overlayDirty = true;
    this.request();
  }
  setDark(dark: boolean) {
    if (this.dark !== dark) {
      this.dark = dark;
      this.mainDirty = true;
      this.overlayDirty = true;
      this.request();
    }
  }
  request() {
    if (!this.frame && !this.disposed)
      this.frame = requestAnimationFrame(this.paint);
  }
  invalidate() {
    this.clearRaster();
    this.mainDirty = true;
    this.overlayDirty = true;
    this.request();
  }
  private paint = (now: number) => {
    this.frame = 0;
    if (this.disposed) return;
    if (this.editor.replay?.playing) {
      this.editor.tickReplay(now);
      this.mainDirty = true;
    }
    if (this.mainDirty) {
      this.mainDirty = false;
      const start = performance.now();
      this.paintMain();
      this.stats.lastMs = performance.now() - start;
      this.stats.samples.push(this.stats.lastMs);
      if (this.stats.samples.length > 600) this.stats.samples.shift();
    }
    if (this.overlayDirty || this.editor.replay) {
      this.overlayDirty = false;
      const start = performance.now();
      this.paintOverlay();
      this.stats.lastOverlayMs = performance.now() - start;
      this.stats.overlaySamples.push(this.stats.lastOverlayMs);
      if (this.stats.overlaySamples.length > 600)
        this.stats.overlaySamples.shift();
    }
    if (this.editor.replay?.playing) this.request();
  };
  private screenTransform(ctx: CanvasRenderingContext2D) {
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0);
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
  }
  private worldTransform(
    ctx: CanvasRenderingContext2D,
    c = this.editor.camera,
  ) {
    ctx.setTransform(
      this.ratio * c.zoom,
      0,
      0,
      this.ratio * c.zoom,
      this.ratio * c.x,
      this.ratio * c.y,
    );
  }
  private paintGrid() {
    const ctx = this.main,
      c = this.editor.camera;
    let spacing = 32 * c.zoom;
    while (spacing < 16) spacing *= 2;
    while (spacing > 64) spacing /= 2;
    const startX = ((c.x % spacing) + spacing) % spacing,
      startY = ((c.y % spacing) + spacing) % spacing;
    ctx.fillStyle = this.dark ? "#343434" : "#d7d7d7";
    ctx.beginPath();
    for (let x = startX; x < this.width; x += spacing)
      for (let y = startY; y < this.height; y += spacing) {
        ctx.moveTo(x + 1, y);
        ctx.arc(x, y, 0.75, 0, Math.PI * 2);
      }
    ctx.fill();
  }
  private paintMain() {
    const ctx = this.main;
    this.stats.mainFrames++;
    this.screenTransform(ctx);
    ctx.fillStyle = this.dark ? "#191919" : "#fafafa";
    ctx.fillRect(0, 0, this.width, this.height);
    if (this.editor.grid && !this.editor.presenting) this.paintGrid();
    const view = this.editor.visibleBounds(),
      hidden = this.editor.hiddenIds,
      els = this.editor.elements,
      camera = this.editor.camera,
      raster = this.sceneRaster;
    const reusable =
      !this.editor.presenting &&
      !hidden.size &&
      !this.editor.replay &&
      !this.editor.editing &&
      raster &&
      raster.elements === els &&
      raster.zoom === camera.zoom &&
      raster.dark === this.dark &&
      raster.grid === this.editor.grid;
    if (reusable) {
      ctx.drawImage(
        raster.canvas,
        camera.x - raster.x,
        camera.y - raster.y,
        this.width,
        this.height,
      );
      this.stats.visible = els.reduce(
        (n, e) => n + Number(intersects(bounds(e), view)),
        0,
      );
      return;
    }
    this.clearRaster();
    this.worldTransform(ctx);
    const slide = this.editor.presenting
      ? els.find((e) => e.id === this.editor.presentationFrame)
      : null;
    if (slide) {
      ctx.save();
      ctx.beginPath();
      const center = rotationCenter(slide),
        corners = [
          { x: slide.x, y: slide.y },
          { x: slide.x + slide.width, y: slide.y },
          { x: slide.x + slide.width, y: slide.y + slide.height },
          { x: slide.x, y: slide.y + slide.height },
        ].map((p) => rotatePoint(p, center, slide.rotation ?? 0));
      corners.forEach((p, i) =>
        i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y),
      );
      ctx.closePath();
      ctx.clip();
    }
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const drawStart = performance.now();
    let visible = 0,
      elapsed = this.editor.replay
        ? this.editor.replay.progress * this.editor.replay.duration
        : Infinity;
    for (const el of els) {
      const duration = this.editor.elementDuration(el),
        fraction = Math.min(1, elapsed / duration);
      elapsed -= duration;
      if (fraction <= 0) break;
      if (
        el.hidden ||
        (slide && el.kind === "frame") ||
        hidden.has(el.id) ||
        !intersects(bounds(el), view)
      )
        continue;
      visible++;
      if (
        camera.zoom < 0.18 &&
        (el.fontSize ?? 18) * camera.zoom < 4 &&
        ["text", "sticky", "table", "task", "link", "math"].includes(el.kind)
      ) {
        this.drawOverview(ctx, el);
        continue;
      }
      if (
        !el.rotation &&
        !el.connectorStyle &&
        !el.label &&
        (el.kind === "rectangle" ||
          el.kind === "ellipse" ||
          el.kind === "diamond" ||
          el.kind === "line" ||
          el.kind === "arrow")
      )
        this.drawFlatShape(ctx, el);
      else this.drawElement(ctx, el, this.dark, fraction);
    }
    if (slide) ctx.restore();
    this.lastPhases.drawingMs = performance.now() - drawStart;
    this.lastPhases.rasterMs = 0;
    ctx.globalAlpha = 1;
    this.stats.visible = visible;
    this.stats.cachedPaths = this.paths.size;
    if (
      els.length >= 2000 &&
      !this.editor.presenting &&
      visible === els.length &&
      !hidden.size &&
      !this.editor.replay &&
      !this.editor.editing &&
      this.canvas.width * this.canvas.height <= 8_000_000
    ) {
      const b = unionBounds(els)!;
      if (
        b.minX * camera.zoom + camera.x >= 0 &&
        b.minY * camera.zoom + camera.y >= 0 &&
        b.maxX * camera.zoom + camera.x <= this.width &&
        b.maxY * camera.zoom + camera.y <= this.height
      ) {
        const rasterStart = performance.now();
        const copy = document.createElement("canvas");
        copy.width = this.canvas.width;
        copy.height = this.canvas.height;
        copy.getContext("2d")!.drawImage(this.canvas, 0, 0);
        this.sceneRaster = {
          canvas: copy,
          elements: els,
          x: camera.x,
          y: camera.y,
          zoom: camera.zoom,
          dark: this.dark,
          grid: this.editor.grid,
        };
        this.lastPhases.rasterMs = performance.now() - rasterStart;
      }
    }
    if (this.paths.size > 4096) {
      const ids = new Set(els.map((e) => e.id));
      for (const id of this.paths.keys()) {
        if (!ids.has(id)) this.paths.delete(id);
        if (this.paths.size <= 4096) break;
      }
      while (this.paths.size > 4096)
        this.paths.delete(this.paths.keys().next().value!);
    }
    if (this.images.size > 128) {
      const ids = new Set(
        els
          .filter((e) => e.kind === "image" || e.kind === "math")
          .map((e) => e.id),
      );
      for (const [key, entry] of this.images)
        if (!ids.has(entry.elementId)) this.images.delete(key);
    }
  }
  private clearRaster() {
    this.sceneRaster = null;
  }
  private outlinePath(el: SceneElement, points: InkPoint[]): Path2D {
    const outline = getStroke(
      points.map((p) => [p[0], p[1], p[2]]),
      {
        size: el.strokeWidth,
        thinning: 1 - (el.ink?.minWidth ?? 40) / 100,
        smoothing: (el.ink?.smoothing ?? 60) / 100,
        streamline: (el.ink?.stabilization ?? 12) / 100,
        simulatePressure: false,
        last: true,
      },
    );
    const path = new Path2D();
    if (outline.length) {
      path.moveTo(outline[0][0], outline[0][1]);
      for (let i = 0; i < outline.length; i++) {
        const a = outline[i],
          b = outline[(i + 1) % outline.length];
        path.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
      }
      path.closePath();
    }
    return path;
  }
  /** At overview scales, subpixel text becomes quiet geometry; exports stay full fidelity. */
  private drawOverview(ctx: CanvasRenderingContext2D, el: SceneElement) {
    if (el.rotation) {
      ctx.save();
      const c = rotationCenter(el);
      ctx.translate(c.x, c.y);
      ctx.rotate((el.rotation * Math.PI) / 180);
      ctx.translate(-c.x, -c.y);
    }
    ctx.globalAlpha = el.opacity;
    ctx.fillStyle = el.fill === "transparent" ? "#ffffff" : el.fill;
    ctx.strokeStyle = this.inkColor(el, this.dark);
    ctx.lineWidth = el.strokeWidth;
    if (el.kind === "text" || el.kind === "math") {
      ctx.globalAlpha *= 0.5;
      ctx.fillStyle = this.inkColor(el, this.dark);
      ctx.fillRect(
        el.x,
        el.y + el.height * 0.2,
        el.width,
        Math.min(el.height, el.fontSize ?? 18) * 0.6,
      );
    } else {
      const tiny =
        Math.min(el.width, el.height) * this.editor.camera.zoom <= 12 &&
        el.strokeWidth * this.editor.camera.zoom < 0.45;
      if (tiny && (el.fill === "#ffffff" || el.fill === "transparent")) {
        ctx.fillStyle = this.inkColor(el, this.dark);
        ctx.globalAlpha *= 0.22;
      }
      ctx.fillRect(el.x, el.y, el.width, el.height);
      if (el.kind !== "sticky" && !tiny)
        ctx.strokeRect(el.x, el.y, el.width, el.height);
      if (Math.min(el.width, el.height) * this.editor.camera.zoom > 12) {
        ctx.globalAlpha *= 0.22;
        ctx.fillStyle = this.inkColor(el, this.dark);
        ctx.fillRect(
          el.x + el.width * 0.1,
          el.y + el.height * 0.2,
          el.width * 0.65,
          Math.max(2, el.height * 0.05),
        );
      }
    }
    if (el.rotation) ctx.restore();
  }
  private strokeParts(el: SceneElement): InkCache {
    const points = el.points!,
      last = points.at(-1)!;
    let cached = this.paths.get(el.id);
    if (
      !cached ||
      cached.first !== points[0] ||
      cached.width !== el.strokeWidth ||
      points.length < cached.consumed + INK_OVERLAP
    ) {
      cached = {
        first: points[0],
        last: undefined,
        width: el.strokeWidth,
        consumed: 0,
        chunks: [],
        tail: new Path2D(),
        count: 0,
      };
      this.paths.set(el.id, cached);
    }
    while (points.length - cached.consumed > INK_TAIL) {
      cached.chunks.push(
        this.outlinePath(
          el,
          points.slice(
            Math.max(0, cached.consumed - INK_OVERLAP),
            cached.consumed + INK_BLOCK + INK_OVERLAP,
          ),
        ),
      );
      cached.consumed += INK_BLOCK;
    }
    if (cached.count !== points.length || cached.last !== last) {
      cached.tail = this.outlinePath(
        el,
        points.slice(Math.max(0, cached.consumed - INK_OVERLAP)),
      );
      cached.count = points.length;
      cached.last = last;
      cached.finalPath = undefined;
    }
    return cached;
  }
  private inkPath(el: SceneElement): Path2D {
    const cached = this.strokeParts(el);
    if (
      cached.finalPath &&
      cached.finalCount === el.points!.length &&
      cached.finalLast === el.points!.at(-1)
    )
      return cached.finalPath;
    const path = new Path2D();
    for (const chunk of cached.chunks) path.addPath(chunk);
    path.addPath(cached.tail);
    cached.finalPath = path;
    cached.finalCount = el.points!.length;
    cached.finalLast = el.points!.at(-1);
    return path;
  }
  private inkColor(el: SceneElement, dark: boolean) {
    return dark && el.color === "#242424" && el.kind !== "sticky"
      ? "#f0f0f0"
      : el.color;
  }
  /** Absolute geometry keeps the hot scene loop free of save/translate/restore. */
  private drawFlatShape(ctx: CanvasRenderingContext2D, el: SceneElement) {
    const x = el.x,
      y = el.y;
    ctx.globalAlpha = el.opacity;
    ctx.strokeStyle = this.inkColor(el, this.dark);
    ctx.lineWidth = el.strokeWidth;
    if (
      el.kind === "rectangle" &&
      Math.min(el.width, el.height) * this.editor.camera.zoom < 18
    ) {
      if (el.fill !== "transparent") {
        ctx.fillStyle = el.fill;
        ctx.fillRect(x, y, el.width, el.height);
      }
      ctx.strokeRect(x, y, el.width, el.height);
      return;
    }
    ctx.beginPath();
    if (el.kind === "rectangle") {
      if (Math.min(el.width, el.height) * this.editor.camera.zoom < 18)
        ctx.rect(x, y, el.width, el.height);
      else
        ctx.roundRect(
          x,
          y,
          el.width,
          el.height,
          Math.min(8, el.width / 2, el.height / 2),
        );
    } else if (el.kind === "ellipse")
      ctx.ellipse(
        x + el.width / 2,
        y + el.height / 2,
        el.width / 2,
        el.height / 2,
        0,
        0,
        Math.PI * 2,
      );
    else if (el.kind === "diamond") {
      ctx.moveTo(x + el.width / 2, y);
      ctx.lineTo(x + el.width, y + el.height / 2);
      ctx.lineTo(x + el.width / 2, y + el.height);
      ctx.lineTo(x, y + el.height / 2);
      ctx.closePath();
    } else {
      ctx.moveTo(x, y);
      ctx.lineTo(x + (el.endX ?? 0), y + (el.endY ?? 0));
    }
    if (
      el.fill !== "transparent" &&
      el.kind !== "arrow" &&
      el.kind !== "line"
    ) {
      ctx.fillStyle = el.fill;
      ctx.fill();
    }
    ctx.stroke();
    if (el.kind === "arrow" && Math.hypot(el.endX ?? 0, el.endY ?? 0) > 1) {
      const ex = x + (el.endX ?? 0),
        ey = y + (el.endY ?? 0),
        angle = Math.atan2(el.endY ?? 0, el.endX ?? 0),
        size = Math.max(10, el.strokeWidth * 3.5);
      ctx.beginPath();
      ctx.moveTo(
        ex - Math.cos(angle - 0.48) * size,
        ey - Math.sin(angle - 0.48) * size,
      );
      ctx.lineTo(ex, ey);
      ctx.lineTo(
        ex - Math.cos(angle + 0.48) * size,
        ey - Math.sin(angle + 0.48) * size,
      );
      ctx.stroke();
    }
  }
  drawElement(
    ctx: CanvasRenderingContext2D,
    el: SceneElement,
    dark = false,
    fraction = 1,
  ) {
    ctx.save();
    if (el.hidden) {
      ctx.restore();
      return;
    }
    if (el.rotation) {
      const c = rotationCenter(el);
      ctx.translate(c.x, c.y);
      ctx.rotate((el.rotation * Math.PI) / 180);
      ctx.translate(-c.x, -c.y);
    }
    ctx.translate(el.x, el.y);
    ctx.globalAlpha = el.opacity;
    ctx.strokeStyle = this.inkColor(el, dark);
    ctx.fillStyle = el.fill;
    ctx.lineWidth = el.strokeWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (el.kind === "stroke") {
      ctx.fillStyle = this.inkColor(el, dark);
      if (fraction >= 1) ctx.fill(this.inkPath(el));
      else this.drawPartialInk(ctx, el, fraction);
    } else if (
      el.kind === "rectangle" ||
      el.kind === "ellipse" ||
      el.kind === "diamond"
    ) {
      ctx.beginPath();
      if (el.kind === "rectangle")
        ctx.roundRect(
          0,
          0,
          el.width,
          el.height,
          Math.min(8, el.width / 2, el.height / 2),
        );
      else if (el.kind === "ellipse")
        ctx.ellipse(
          el.width / 2,
          el.height / 2,
          Math.max(0, el.width / 2),
          Math.max(0, el.height / 2),
          0,
          0,
          Math.PI * 2,
        );
      else {
        ctx.moveTo(el.width / 2, 0);
        ctx.lineTo(el.width, el.height / 2);
        ctx.lineTo(el.width / 2, el.height);
        ctx.lineTo(0, el.height / 2);
        ctx.closePath();
      }
      if (el.fill !== "transparent") ctx.fill();
      ctx.stroke();
    } else if (el.kind === "line" || el.kind === "arrow") {
      const points = connectorPoints(el),
        last = points.at(-1)!,
        previous = points.at(-2) ?? { x: 0, y: 0 },
        x = last.x,
        y = last.y;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      for (const p of points.slice(1)) ctx.lineTo(p.x, p.y);
      ctx.stroke();
      if (el.kind === "arrow" && Math.hypot(x, y) > 1) {
        const angle = Math.atan2(y - previous.y, x - previous.x),
          size = Math.max(10, el.strokeWidth * 3.5);
        ctx.beginPath();
        ctx.moveTo(
          x - Math.cos(angle - 0.48) * size,
          y - Math.sin(angle - 0.48) * size,
        );
        ctx.lineTo(x, y);
        ctx.lineTo(
          x - Math.cos(angle + 0.48) * size,
          y - Math.sin(angle + 0.48) * size,
        );
        ctx.stroke();
      }
      if (el.label) {
        const p = connectorMidpoint(el),
          size = el.fontSize ?? 18;
        ctx.font = `${size}px "Segoe UI",sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        const w = Math.min(800, ctx.measureText(el.label).width + 16);
        ctx.fillStyle = dark ? "#292929" : "#ffffff";
        ctx.fillRect(p.x - w / 2, p.y - size * 0.7, w, size * 1.4);
        ctx.fillStyle = this.inkColor(el, dark);
        ctx.fillText(el.label, p.x, p.y, w - 8);
      }
    } else if (["table", "task", "link"].includes(el.kind)) {
      drawStructured(ctx, el, dark);
    } else if (el.kind === "frame") {
      const size = el.fontSize ?? 20;
      ctx.strokeStyle = el.color;
      ctx.setLineDash([8, 5]);
      ctx.strokeRect(0, 0, el.width, el.height);
      ctx.setLineDash([]);
      ctx.fillStyle = dark ? "#292929" : "#ffffff";
      ctx.fillRect(0, 0, el.width, Math.min(el.height, size * 1.35 + 8));
      ctx.fillStyle = dark ? "#e0e0e0" : el.color;
      ctx.font = `${el.italic ? "italic " : ""}${el.bold ? "700" : "500"} ${size}px "Segoe UI", sans-serif`;
      ctx.textAlign = el.textAlign ?? "left";
      ctx.textBaseline = "top";
      ctx.fillText(
        el.text ?? "Фрейм",
        el.textAlign === "center"
          ? el.width / 2
          : el.textAlign === "right"
            ? el.width - 10
            : 10,
        5,
        Math.max(1, el.width - 20),
      );
    } else if (el.kind === "text" || el.kind === "sticky") {
      const sticky = el.kind === "sticky",
        padding = sticky ? 20 : 0;
      if (sticky) {
        ctx.fillStyle = el.fill === "transparent" ? "#fff1a8" : el.fill;
        ctx.beginPath();
        ctx.roundRect(0, 0, el.width, el.height, 4);
        ctx.fill();
        ctx.fillStyle = "#000000";
        ctx.globalAlpha = el.opacity * 0.035;
        ctx.fillRect(0, el.height - 5, el.width, 5);
        ctx.globalAlpha = el.opacity;
      }
      const size = el.fontSize ?? 24;
      ctx.font = `${el.italic ? "italic " : ""}${el.bold ? "700 " : ""}${size}px "Segoe UI", sans-serif`;
      ctx.textAlign = el.textAlign ?? "left";
      ctx.textBaseline = "top";
      ctx.fillStyle = sticky ? "#242424" : this.inkColor(el, dark);
      ctx.beginPath();
      ctx.rect(0, 0, el.width, el.height);
      ctx.clip();
      let lines = this.textLayouts.get(el);
      if (!lines) {
        lines = wrapText(
          ctx,
          el.text ?? "",
          Math.max(10, el.width - padding * 2),
        );
        this.textLayouts.set(el, lines);
      }
      for (let i = 0; i < lines.length; i++) {
        const y = padding + i * size * 1.35;
        if (y >= el.height) break;
        ctx.fillText(
          lines[i],
          el.textAlign === "center"
            ? el.width / 2
            : el.textAlign === "right"
              ? el.width - padding
              : padding,
          y,
        );
      }
    } else if ((el.kind === "image" && el.dataUrl) || el.kind === "math") {
      const image = this.getImage(el, dark);
      if (image.complete && image.naturalWidth)
        ctx.drawImage(image, 0, 0, el.width, el.height);
      else {
        ctx.fillStyle = dark ? "#303030" : "#e8e8e8";
        ctx.fillRect(0, 0, el.width, el.height);
        const entry = this.images.get(
          el.kind === "math" ? `${el.id}:math:${dark}` : el.id,
        );
        if (entry?.error) {
          ctx.fillStyle = dark ? "#ffb6b6" : "#a4262c";
          ctx.font = '14px "Segoe UI", sans-serif';
          ctx.textBaseline = "top";
          ctx.fillText(
            el.kind === "math" ? "Ошибка формулы" : "Ошибка изображения",
            8,
            8,
            Math.max(1, el.width - 16),
          );
        }
      }
    }
    ctx.restore();
  }
  private drawPartialInk(
    ctx: CanvasRenderingContext2D,
    el: SceneElement,
    fraction: number,
  ) {
    const points = el.points ?? [],
      count = Math.max(1, Math.ceil(points.length * fraction));
    ctx.fill(
      this.inkPath({
        ...el,
        id: `${el.id}:replay`,
        points: points.slice(0, count),
      }),
    );
  }
  private getImage(el: SceneElement, dark = false): HTMLImageElement {
    const key = el.kind === "math" ? `${el.id}:math:${dark}` : el.id;
    const data =
      el.kind === "math"
        ? `${el.text}|${this.inkColor(el, dark)}`
        : el.dataUrl!;
    const existing = this.images.get(key);
    if (existing && existing.data === data) return existing.image;
    const image = new Image();
    const entry = {
      data,
      image,
      ready: Promise.resolve(),
      elementId: el.id,
      error: "",
    };
    const ready = (async () => {
      image.src =
        el.kind === "math"
          ? (await import("./math")).renderFormula(
              el.text ?? "",
              this.inkColor(el, dark),
            ).dataUrl
          : data;
      await image.decode();
    })()
      .then(() => {
        this.invalidate();
      })
      .catch((error) => {
        entry.error = String(error);
        this.invalidate();
      });
    entry.ready = ready;
    this.images.set(key, entry);
    return image;
  }
  private clearOverlay() {
    this.screenTransform(this.overlay);
    this.overlay.clearRect(0, 0, this.width, this.height);
  }
  private paintOverlay() {
    this.stats.overlayFrames++;
    if (this.editor.presenting) {
      this.clearOverlay();
      return;
    }
    const ctx = this.overlay,
      g = this.editor.gesture,
      c = this.editor.camera;
    if (g?.type === "ink") {
      this.overlayCanvas.style.opacity = String(g.element.opacity);
      const cameraKey = `${c.x}:${c.y}:${c.zoom}:${this.ratio}:${this.dark}`;
      if (this.inkId !== g.element.id || cameraKey !== this.inkCamera) {
        this.inkBaseContext.setTransform(1, 0, 0, 1, 0, 0);
        this.inkBaseContext.clearRect(
          0,
          0,
          this.inkBase.width,
          this.inkBase.height,
        );
        this.inkId = g.element.id;
        this.inkCamera = cameraKey;
        this.inkPaintedChunks = 0;
      }
      const el = g.element,
        parts = this.strokeParts(el),
        base = this.inkBaseContext;
      this.worldTransform(base);
      base.save();
      base.translate(el.x, el.y);
      base.fillStyle = this.inkColor(el, this.dark);
      base.globalAlpha = 1;
      for (let i = this.inkPaintedChunks; i < parts.chunks.length; i++)
        base.fill(parts.chunks[i]);
      base.restore();
      this.inkPaintedChunks = parts.chunks.length;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
      ctx.drawImage(this.inkBase, 0, 0);
      this.worldTransform(ctx);
      ctx.save();
      ctx.translate(el.x, el.y);
      ctx.fillStyle = this.inkColor(el, this.dark);
      ctx.fill(parts.tail);
      ctx.restore();
      this.stats.inkTailPoints =
        el.points!.length - Math.max(0, parts.consumed - INK_OVERLAP);
      return;
    }
    this.overlayCanvas.style.opacity = "1";
    this.inkId = "";
    this.inkPaintedChunks = 0;
    this.stats.inkTailPoints = 0;
    this.clearOverlay();
    if (this.editor.replay) return;
    this.worldTransform(ctx);
    const view = this.editor.visibleBounds();
    for (const guide of this.editor.guides) {
      ctx.strokeStyle = "#d34d9b";
      ctx.lineWidth = 1 / c.zoom;
      ctx.setLineDash([4 / c.zoom, 4 / c.zoom]);
      ctx.beginPath();
      if (guide.axis === "x") {
        ctx.moveTo(guide.value, view.minY);
        ctx.lineTo(guide.value, view.maxY);
      } else {
        ctx.moveTo(view.minX, guide.value);
        ctx.lineTo(view.maxX, guide.value);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    for (const el of this.editor.previewElements)
      if (intersects(bounds(el), view)) this.drawElement(ctx, el, this.dark);
    if (this.editor.editing) {
      const el = this.editor.editing.element;
      this.drawElement(ctx, { ...el, text: "" }, this.dark);
    }
    const b = this.editor.selectionBounds,
      selected =
        this.editor.selection.length === 1 ? this.editor.selection[0] : null;
    const bound =
      selected?.kind === "arrow" &&
      (selected.startBinding || selected.endBinding);
    if (b && !bound) {
      const z = c.zoom;
      ctx.globalAlpha = 1;
      ctx.strokeStyle = this.dark ? "#62abf5" : "#0f6cbd";
      ctx.lineWidth = 1.3 / z;
      ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
      if (!this.editor.selection.some((e) => e.locked)) {
        const x = (b.minX + b.maxX) / 2,
          y = b.minY - 28 / z;
        ctx.beginPath();
        ctx.moveTo(x, b.minY);
        ctx.lineTo(x, y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, 5 / z, 0, Math.PI * 2);
        ctx.fillStyle = this.dark ? "#292929" : "#ffffff";
        ctx.fill();
        ctx.stroke();
      }
      for (const [x, y] of [
        [b.minX, b.minY],
        [b.maxX, b.minY],
        [b.maxX, b.maxY],
        [b.minX, b.maxY],
      ]) {
        ctx.fillStyle = this.dark ? "#292929" : "#ffffff";
        ctx.fillRect(x - 4 / z, y - 4 / z, 8 / z, 8 / z);
        ctx.strokeRect(x - 4 / z, y - 4 / z, 8 / z, 8 / z);
      }
    }
    if (bound && selected) {
      ctx.lineWidth = 1.5 / c.zoom;
      ctx.strokeStyle = this.dark ? "#62abf5" : "#0f6cbd";
      ctx.fillStyle = this.dark ? "#292929" : "#fff";
      const arrow = g?.type === "endpoint" ? g.element : selected;
      for (const [x, y] of [
        [arrow.x, arrow.y],
        [arrow.x + (arrow.endX ?? 0), arrow.y + (arrow.endY ?? 0)],
      ]) {
        ctx.beginPath();
        ctx.arc(x, y, 5 / c.zoom, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    if (g?.type === "marquee") {
      const x = Math.min(g.start.x, g.end.x),
        y = Math.min(g.start.y, g.end.y),
        w = Math.abs(g.start.x - g.end.x),
        h = Math.abs(g.start.y - g.end.y);
      ctx.fillStyle = "#0f6cbd";
      ctx.globalAlpha = 0.1;
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 0.8;
      ctx.strokeStyle = "#0f6cbd";
      ctx.lineWidth = 1 / c.zoom;
      ctx.strokeRect(x, y, w, h);
    }
    if (this.editor.tool === "eraser" && this.editor.pointer) {
      this.screenTransform(ctx);
      ctx.strokeStyle = this.dark ? "#c7c7c7" : "#616161";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(
        this.editor.pointer.x,
        this.editor.pointer.y,
        this.editor.eraserSize / 2,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }
  }
  async exportPng(
    selectionOnly = false,
    frameId?: string,
  ): Promise<{ dataUrl: string; width: number; height: number }> {
    let elements =
      selectionOnly && this.editor.selected.size
        ? this.editor.selection
        : this.editor.elements;
    const frame = frameId
      ? this.editor.elements.find((e) => e.id === frameId && e.kind === "frame")
      : null;
    if (frame)
      elements = this.editor.elements.filter(
        (e) => e.id !== frame.id && intersects(bounds(e), bounds(frame)),
      );
    elements = elements.filter((e) => !e.hidden);
    const b = frame
      ? frame.rotation
        ? bounds(frame)
        : {
            minX: frame.x,
            minY: frame.y,
            maxX: frame.x + frame.width,
            maxY: frame.y + frame.height,
          }
      : unionBounds(elements);
    if (!b) throw new Error("Добавьте что-нибудь на доску перед экспортом.");
    for (const el of elements)
      if (el.kind === "image" || el.kind === "math") this.getImage(el);
    await Promise.all(
      elements
        .filter((e) => e.kind === "image" || e.kind === "math")
        .map(
          (e) =>
            this.images.get(e.kind === "math" ? `${e.id}:math:false` : e.id)!
              .ready,
        ),
    );
    for (const e of elements) {
      if (e.kind !== "image" && e.kind !== "math") continue;
      const cached = this.images.get(
        e.kind === "math" ? `${e.id}:math:false` : e.id,
      );
      if (cached?.error)
        throw new Error(
          e.kind === "math"
            ? "Не удалось отрисовать формулу. Откройте её двойным щелчком и проверьте запись."
            : "Не удалось загрузить изображение для экспорта.",
        );
    }
    const w = b.maxX - b.minX + 64,
      h = b.maxY - b.minY + 64,
      scale = Math.min(2, 8192 / w, 8192 / h, Math.sqrt(32_000_000 / (w * h)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(w * scale));
    canvas.height = Math.max(1, Math.ceil(h * scale));
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(
      scale,
      0,
      0,
      scale,
      (32 - b.minX) * scale,
      (32 - b.minY) * scale,
    );
    if (frame) {
      ctx.beginPath();
      ctx.save();
      const c = rotationCenter(frame);
      ctx.translate(c.x, c.y);
      ctx.rotate(((frame.rotation ?? 0) * Math.PI) / 180);
      ctx.translate(-c.x, -c.y);
      ctx.rect(frame.x, frame.y, frame.width, frame.height);
      ctx.restore();
      ctx.clip();
    }
    for (const el of elements) this.drawElement(ctx, el, false);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Не удалось создать PNG."))),
        "image/png",
      ),
    );
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    return { dataUrl, width: canvas.width, height: canvas.height };
  }
  measure(frames = 60): Promise<number[]> {
    return new Promise((resolve) => {
      const samples: number[] = [];
      const tick = () => {
        if (this.disposed) {
          resolve(samples);
          return;
        }
        const start = performance.now();
        this.paintMain();
        samples.push(performance.now() - start);
        if (samples.length < frames) requestAnimationFrame(tick);
        else resolve(samples);
      };
      requestAnimationFrame(tick);
    });
  }
}
