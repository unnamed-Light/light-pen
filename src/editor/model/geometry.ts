import type { Bounds, Camera, InkPoint, SceneElement, Vec } from "./types";
import { connectorPoints, connectorLabelBounds } from "./connectors";

export const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));
export const screenToWorld = (p: Vec, c: Camera): Vec => ({
  x: (p.x - c.x) / c.zoom,
  y: (p.y - c.y) / c.zoom,
});
export const worldToScreen = (p: Vec, c: Camera): Vec => ({
  x: p.x * c.zoom + c.x,
  y: p.y * c.zoom + c.y,
});
export function zoomAt(c: Camera, screen: Vec, factor: number): Camera {
  const p = screenToWorld(screen, c);
  const zoom = clamp(c.zoom * factor, 0.05, 8);
  return { x: screen.x - p.x * zoom, y: screen.y - p.y * zoom, zoom };
}
export const intersects = (a: Bounds, b: Bounds) =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
export const contains = (b: Bounds, p: Vec, pad = 0) =>
  p.x >= b.minX - pad &&
  p.x <= b.maxX + pad &&
  p.y >= b.minY - pad &&
  p.y <= b.maxY + pad;
export const rectFromPoints = (a: Vec, b: Vec): Bounds => ({
  minX: Math.min(a.x, b.x),
  minY: Math.min(a.y, b.y),
  maxX: Math.max(a.x, b.x),
  maxY: Math.max(a.y, b.y),
});
export const expand = (b: Bounds, p: number): Bounds => ({
  minX: b.minX - p,
  minY: b.minY - p,
  maxX: b.maxX + p,
  maxY: b.maxY + p,
});

const boundsCache = new WeakMap<SceneElement, Bounds>();
const localStrokeBounds = new WeakMap<InkPoint[], Bounds>();
export function unrotatedBounds(el: SceneElement): Bounds {
  const cached = boundsCache.get(el);
  if (cached) return cached;
  let b: Bounds;
  if (el.kind === "stroke" && el.points?.length) {
    let local = localStrokeBounds.get(el.points);
    if (!local) {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const p of el.points) {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
      }
      local = { minX, minY, maxX, maxY };
      localStrokeBounds.set(el.points, local);
    }
    b = expand(
      {
        minX: el.x + local.minX,
        minY: el.y + local.minY,
        maxX: el.x + local.maxX,
        maxY: el.y + local.maxY,
      },
      el.strokeWidth,
    );
  } else if (el.kind === "arrow" || el.kind === "line") {
    const pts = connectorPoints(el);
    b = expand(
      {
        minX: el.x + Math.min(...pts.map((p) => p.x)),
        minY: el.y + Math.min(...pts.map((p) => p.y)),
        maxX: el.x + Math.max(...pts.map((p) => p.x)),
        maxY: el.y + Math.max(...pts.map((p) => p.y)),
      },
      Math.max(el.strokeWidth, el.kind === "arrow" ? 12 : 0),
    );
    const label = connectorLabelBounds(el);
    if (label)
      b = {
        minX: Math.min(b.minX, el.x + label.minX),
        minY: Math.min(b.minY, el.y + label.minY),
        maxX: Math.max(b.maxX, el.x + label.maxX),
        maxY: Math.max(b.maxY, el.y + label.maxY),
      };
  } else
    b = expand(
      { minX: el.x, minY: el.y, maxX: el.x + el.width, maxY: el.y + el.height },
      el.strokeWidth / 2,
    );
  boundsCache.set(el, b);
  return b;
}
export function rotationCenter(el: SceneElement): Vec {
  if (el.kind === "arrow" || el.kind === "line")
    return { x: el.x + (el.endX ?? 0) / 2, y: el.y + (el.endY ?? 0) / 2 };
  const b = unrotatedBounds(el);
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
}
export function rotatePoint(p: Vec, c: Vec, degrees: number): Vec {
  const a = (degrees * Math.PI) / 180,
    cos = Math.cos(a),
    sin = Math.sin(a);
  return {
    x: c.x + (p.x - c.x) * cos - (p.y - c.y) * sin,
    y: c.y + (p.x - c.x) * sin + (p.y - c.y) * cos,
  };
}
const rotatedBoundsCache = new WeakMap<SceneElement, Bounds>();
export function bounds(el: SceneElement): Bounds {
  if (!el.rotation) return unrotatedBounds(el);
  const cached = rotatedBoundsCache.get(el);
  if (cached) return cached;
  const b = unrotatedBounds(el),
    c = rotationCenter(el),
    pts = [
      { x: b.minX, y: b.minY },
      { x: b.maxX, y: b.minY },
      { x: b.maxX, y: b.maxY },
      { x: b.minX, y: b.maxY },
    ].map((p) => rotatePoint(p, c, el.rotation!));
  const next = {
    minX: Math.min(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxX: Math.max(...pts.map((p) => p.x)),
    maxY: Math.max(...pts.map((p) => p.y)),
  };
  rotatedBoundsCache.set(el, next);
  return next;
}
export function rotateElements(
  elements: SceneElement[],
  degrees: number,
  center?: Vec,
): SceneElement[] {
  const b = unionBounds(elements);
  if (!b) return elements;
  const pivot = center ?? {
    x: (b.minX + b.maxX) / 2,
    y: (b.minY + b.maxY) / 2,
  };
  return elements.map((el) => {
    if (el.locked || el.startBinding || el.endBinding) return el;
    const c = rotationCenter(el),
      next = rotatePoint(c, pivot, degrees);
    return {
      ...el,
      x: el.x + next.x - c.x,
      y: el.y + next.y - c.y,
      rotation: (((el.rotation ?? 0) + degrees + 540) % 360) - 180,
    };
  });
}
export function unionBounds(elements: SceneElement[]): Bounds | null {
  if (!elements.length) return null;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const el of elements) {
    const b = bounds(el);
    minX = Math.min(minX, b.minX);
    minY = Math.min(minY, b.minY);
    maxX = Math.max(maxX, b.maxX);
    maxY = Math.max(maxY, b.maxY);
  }
  return { minX, minY, maxX, maxY };
}
export function distanceToSegment(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x,
    dy = b.y - a.y,
    l = dx * dx + dy * dy;
  const t = l ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l, 0, 1) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
export function segmentDistance(a: Vec, b: Vec, c: Vec, d: Vec): number {
  const cross = (u: Vec, v: Vec, w: Vec) =>
    (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
  const abC = cross(a, b, c),
    abD = cross(a, b, d),
    cdA = cross(c, d, a),
    cdB = cross(c, d, b);
  if (
    ((abC > 0 && abD < 0) || (abC < 0 && abD > 0)) &&
    ((cdA > 0 && cdB < 0) || (cdA < 0 && cdB > 0))
  )
    return 0;
  return Math.min(
    distanceToSegment(a, c, d),
    distanceToSegment(b, c, d),
    distanceToSegment(c, a, b),
    distanceToSegment(d, a, b),
  );
}
/** Continuous collision detection avoids both eraser gaps and repeated full-scene scans. */
export function sweepHitTest(
  el: SceneElement,
  a: Vec,
  b: Vec,
  tolerance: number,
): boolean {
  if (!intersects(expand(bounds(el), tolerance), rectFromPoints(a, b)))
    return false;
  if (hitTest(el, a, tolerance) || hitTest(el, b, tolerance)) return true;
  if (el.rotation) {
    const c = rotationCenter(el);
    a = rotatePoint(a, c, -el.rotation);
    b = rotatePoint(b, c, -el.rotation);
  }
  const localA = { x: a.x - el.x, y: a.y - el.y },
    localB = { x: b.x - el.x, y: b.y - el.y },
    edge = tolerance + el.strokeWidth / 2;
  if (el.kind === "stroke") {
    const pts = el.points ?? [];
    if (pts.length === 1)
      return (
        distanceToSegment({ x: pts[0][0], y: pts[0][1] }, localA, localB) <=
        edge
      );
    for (let i = 1; i < pts.length; i++)
      if (
        segmentDistance(
          localA,
          localB,
          { x: pts[i - 1][0], y: pts[i - 1][1] },
          { x: pts[i][0], y: pts[i][1] },
        ) <= edge
      )
        return true;
    return false;
  }
  if (el.kind === "line" || el.kind === "arrow") {
    const pts = connectorPoints(el);
    const label = connectorLabelBounds(el);
    if (label) {
      const corners = [
        { x: label.minX, y: label.minY },
        { x: label.maxX, y: label.minY },
        { x: label.maxX, y: label.maxY },
        { x: label.minX, y: label.maxY },
      ];
      if (
        corners.some(
          (p, i) =>
            segmentDistance(localA, localB, p, corners[(i + 1) % 4]) <= edge,
        )
      )
        return true;
    }
    return pts
      .slice(1)
      .some((p, i) => segmentDistance(localA, localB, pts[i], p) <= edge);
  }
  let vertices: Vec[];
  if (el.kind === "ellipse")
    vertices = Array.from({ length: 32 }, (_, i) => ({
      x: el.width / 2 + (Math.cos((i * Math.PI) / 16) * el.width) / 2,
      y: el.height / 2 + (Math.sin((i * Math.PI) / 16) * el.height) / 2,
    }));
  else if (el.kind === "diamond")
    vertices = [
      { x: el.width / 2, y: 0 },
      { x: el.width, y: el.height / 2 },
      { x: el.width / 2, y: el.height },
      { x: 0, y: el.height / 2 },
    ];
  else
    vertices = [
      { x: 0, y: 0 },
      { x: el.width, y: 0 },
      { x: el.width, y: el.height },
      { x: 0, y: el.height },
    ];
  return vertices.some(
    (v, i) =>
      segmentDistance(localA, localB, v, vertices[(i + 1) % vertices.length]) <=
      edge,
  );
}
export function hitTest(el: SceneElement, p: Vec, tolerance: number): boolean {
  if (!contains(bounds(el), p, tolerance)) return false;
  if (el.rotation) p = rotatePoint(p, rotationCenter(el), -el.rotation);
  const local = { x: p.x - el.x, y: p.y - el.y };
  if (el.kind === "frame")
    return (
      (local.y <= (el.fontSize ?? 20) * 1.35 + 8 && local.y >= -tolerance) ||
      Math.min(
        Math.abs(local.x),
        Math.abs(local.y),
        Math.abs(local.x - el.width),
        Math.abs(local.y - el.height),
      ) <=
        tolerance + el.strokeWidth
    );
  if (el.kind === "stroke") {
    const pts = el.points ?? [];
    if (pts.length === 1)
      return (
        Math.hypot(local.x - pts[0][0], local.y - pts[0][1]) <=
        tolerance + el.strokeWidth
      );
    for (let i = 1; i < pts.length; i++)
      if (
        distanceToSegment(
          local,
          { x: pts[i - 1][0], y: pts[i - 1][1] },
          { x: pts[i][0], y: pts[i][1] },
        ) <=
        tolerance + el.strokeWidth / 2
      )
        return true;
    return false;
  }
  if (el.kind === "arrow" || el.kind === "line") {
    const pts = connectorPoints(el);
    return (
      (!!el.label && contains(connectorLabelBounds(el)!, local, tolerance)) ||
      pts
        .slice(1)
        .some(
          (p, i) =>
            distanceToSegment(local, pts[i], p) <= tolerance + el.strokeWidth,
        ) ||
      false
    );
  }
  if (
    el.kind === "text" ||
    el.kind === "sticky" ||
    el.kind === "image" ||
    el.kind === "math" ||
    el.kind === "table" ||
    el.kind === "task" ||
    el.kind === "link"
  )
    return true;
  const edge = tolerance + el.strokeWidth / 2;
  if (el.kind === "ellipse") {
    const rx = Math.max(0.001, el.width / 2),
      ry = Math.max(0.001, el.height / 2);
    const norm = Math.hypot((local.x - rx) / rx, (local.y - ry) / ry);
    return el.fill !== "transparent"
      ? norm <= 1 + edge / Math.min(rx, ry)
      : Math.abs(norm - 1) <= edge / Math.min(rx, ry);
  }
  if (el.kind === "diamond") {
    const verts = [
      { x: el.width / 2, y: 0 },
      { x: el.width, y: el.height / 2 },
      { x: el.width / 2, y: el.height },
      { x: 0, y: el.height / 2 },
    ];
    if (
      el.fill !== "transparent" &&
      Math.abs((local.x - el.width / 2) / Math.max(0.001, el.width / 2)) +
        Math.abs((local.y - el.height / 2) / Math.max(0.001, el.height / 2)) <=
        1
    )
      return true;
    return verts.some(
      (v, i) => distanceToSegment(local, v, verts[(i + 1) % 4]) <= edge,
    );
  }
  if (el.fill !== "transparent") return true;
  return (
    Math.min(
      Math.abs(local.x),
      Math.abs(local.y),
      Math.abs(local.x - el.width),
      Math.abs(local.y - el.height),
    ) <= edge
  );
}
export function translateElement(
  el: SceneElement,
  dx: number,
  dy: number,
): SceneElement {
  return { ...el, x: el.x + dx, y: el.y + dy };
}
export function resizeElement(
  el: SceneElement,
  from: Bounds,
  to: Bounds,
): SceneElement {
  const sx = (to.maxX - to.minX) / Math.max(0.001, from.maxX - from.minX),
    sy = (to.maxY - to.minY) / Math.max(0.001, from.maxY - from.minY);
  return {
    ...el,
    x: to.minX + (el.x - from.minX) * sx,
    y: to.minY + (el.y - from.minY) * sy,
    width: el.width * sx,
    height: el.height * sy,
    ...(el.points
      ? {
          points: el.points.map(
            (p) =>
              [p[0] * sx, p[1] * sy, p[2], p[3]] as [
                number,
                number,
                number,
                number,
              ],
          ),
        }
      : {}),
    ...(el.endX !== undefined
      ? { endX: el.endX * sx, endY: (el.endY ?? 0) * sy }
      : {}),
    ...(el.fontSize
      ? { fontSize: clamp(el.fontSize * Math.sqrt(sx * sy), 8, 256) }
      : {}),
  };
}
