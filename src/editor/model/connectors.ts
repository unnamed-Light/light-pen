import type { SceneElement, Vec, Bounds } from "./types";

/** Local polyline used by drawing, selection, erasing and vector export alike. */
export function connectorPoints(el: SceneElement): Vec[] {
  const end = { x: el.endX ?? 0, y: el.endY ?? 0 };
  if (el.connectorStyle === "orthogonal")
    return el.route?.length
      ? el.route
      : [
          { x: 0, y: 0 },
          { x: end.x / 2, y: 0 },
          { x: end.x / 2, y: end.y },
          end,
        ];
  if (el.connectorStyle !== "curve") return [{ x: 0, y: 0 }, end];
  const distance = Math.max(40, Math.hypot(end.x, end.y) * 0.45);
  const direction = (side: string | undefined, fallback: number): Vec =>
    side === "left"
      ? { x: -distance, y: 0 }
      : side === "right"
        ? { x: distance, y: 0 }
        : side === "top"
          ? { x: 0, y: -distance }
          : side === "bottom"
            ? { x: 0, y: distance }
            : { x: distance * fallback, y: 0 };
  const a = direction(el.startBinding?.side, Math.sign(end.x || 1)),
    b = direction(el.endBinding?.side, -Math.sign(end.x || 1));
  return Array.from({ length: 33 }, (_, i) => {
    const t = i / 32,
      u = 1 - t;
    return {
      x:
        3 * u * u * t * a.x + 3 * u * t * t * (end.x + b.x) + t * t * t * end.x,
      y:
        3 * u * u * t * a.y + 3 * u * t * t * (end.y + b.y) + t * t * t * end.y,
    };
  });
}
export function connectorMidpoint(el: SceneElement): Vec {
  const points = connectorPoints(el),
    lengths = points
      .slice(1)
      .map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  let left = lengths.reduce((a, b) => a + b, 0) / 2;
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i]) {
      const t = lengths[i] ? left / lengths[i] : 0;
      return {
        x: points[i].x + (points[i + 1].x - points[i].x) * t,
        y: points[i].y + (points[i + 1].y - points[i].y) * t,
      };
    }
    left -= lengths[i];
  }
  return points.at(-1)!;
}
export function connectorLabelBounds(el: SceneElement): Bounds | null {
  if (!el.label) return null;
  const p = connectorMidpoint(el),
    size = el.fontSize ?? 18;
  const width = Math.min(
    800,
    Array.from(el.label).reduce(
      (n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 1 : 0.7) * size,
      16,
    ),
  );
  return {
    minX: p.x - width / 2,
    minY: p.y - size * 0.7,
    maxX: p.x + width / 2,
    maxY: p.y + size * 0.7,
  };
}
