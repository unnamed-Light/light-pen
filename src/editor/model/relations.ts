import {
  bounds,
  contains,
  rotatePoint,
  rotationCenter,
  unrotatedBounds,
} from "./geometry";
import type { Binding, SceneElement, Vec } from "./types";

export function anchor(el: SceneElement, side: Binding["side"]): Vec {
  const b = unrotatedBounds(el),
    x = (b.minX + b.maxX) / 2,
    y = (b.minY + b.maxY) / 2;
  const p =
    side === "left"
      ? { x: b.minX, y }
      : side === "right"
        ? { x: b.maxX, y }
        : side === "top"
          ? { x, y: b.minY }
          : { x, y: b.maxY };
  return el.rotation ? rotatePoint(p, rotationCenter(el), el.rotation) : p;
}
export function bindingAt(
  p: Vec,
  elements: SceneElement[],
  tolerance: number,
): Binding | undefined {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (
      ["stroke", "arrow", "line", "frame"].includes(el.kind) ||
      el.hidden ||
      el.locked ||
      !contains(bounds(el), p, tolerance)
    )
      continue;
    const sides: Binding["side"][] = ["left", "right", "top", "bottom"];
    sides.sort((a, b) => {
      const pa = anchor(el, a),
        pb = anchor(el, b);
      return (
        Math.hypot(p.x - pa.x, p.y - pa.y) - Math.hypot(p.x - pb.x, p.y - pb.y)
      );
    });
    return { elementId: el.id, side: sides[0] };
  }
}
export function resolveBindings(elements: SceneElement[]): SceneElement[] {
  if (
    !elements.some(
      (e) =>
        e.startBinding || e.endBinding || e.connectorStyle === "orthogonal",
    )
  )
    return elements;
  const byId = new Map(elements.map((e) => [e.id, e]));
  return elements.map((el) => {
    if (!["arrow", "line"].includes(el.kind)) return el;
    const start = el.startBinding && byId.get(el.startBinding.elementId),
      end = el.endBinding && byId.get(el.endBinding.elementId);
    const a = start
      ? anchor(start, el.startBinding!.side)
      : { x: el.x, y: el.y };
    const b = end
      ? anchor(end, el.endBinding!.side)
      : { x: el.x + (el.endX ?? 0), y: el.y + (el.endY ?? 0) };
    const next = {
      ...el,
      x: a.x,
      y: a.y,
      endX: b.x - a.x,
      endY: b.y - a.y,
      width: Math.abs(b.x - a.x),
      height: Math.abs(b.y - a.y),
      startBinding: start ? el.startBinding : undefined,
      endBinding: end ? el.endBinding : undefined,
    };
    const route =
      el.connectorStyle === "orthogonal"
        ? routeOrthogonal(next, elements)
        : undefined;
    if (
      a.x === el.x &&
      a.y === el.y &&
      b.x - a.x === el.endX &&
      b.y - a.y === el.endY &&
      !!start === !!el.startBinding &&
      !!end === !!el.endBinding &&
      JSON.stringify(route) === JSON.stringify(el.route)
    )
      return el;
    return { ...next, route };
  });
}
/** Score Manhattan candidates against nearby obstacles; only runs on scene edits. */
function routeOrthogonal(el: SceneElement, elements: SceneElement[]): Vec[] {
  const a = { x: el.x, y: el.y },
    b = { x: el.x + (el.endX ?? 0), y: el.y + (el.endY ?? 0) },
    pad = 24;
  const stub = (p: Vec, side: string | undefined): Vec => ({
    x: p.x + (side === "left" ? -pad : side === "right" ? pad : 0),
    y: p.y + (side === "top" ? -pad : side === "bottom" ? pad : 0),
  });
  const s = stub(a, el.startBinding?.side),
    t = stub(b, el.endBinding?.side);
  const obstacles = elements
    .filter(
      (e) =>
        e.id !== el.id &&
        !e.hidden &&
        !["stroke", "line", "arrow", "frame"].includes(e.kind) &&
        e.id !== el.startBinding?.elementId &&
        e.id !== el.endBinding?.elementId,
    )
    .map((e) => bounds(e))
    .filter(
      (r) =>
        r.maxX >= Math.min(a.x, b.x) - 200 &&
        r.minX <= Math.max(a.x, b.x) + 200 &&
        r.maxY >= Math.min(a.y, b.y) - 200 &&
        r.minY <= Math.max(a.y, b.y) + 200,
    );
  const xs = [
      (s.x + t.x) / 2,
      Math.min(s.x, t.x) - 40,
      Math.max(s.x, t.x) + 40,
    ],
    ys = [(s.y + t.y) / 2, Math.min(s.y, t.y) - 40, Math.max(s.y, t.y) + 40];
  for (const r of obstacles.slice(0, 40)) {
    xs.push(r.minX - pad, r.maxX + pad);
    ys.push(r.minY - pad, r.maxY + pad);
  }
  const routes: Vec[][] = [
    [s, { x: t.x, y: s.y }, t],
    [s, { x: s.x, y: t.y }, t],
    ...xs.map((x) => [s, { x, y: s.y }, { x, y: t.y }, t]),
    ...ys.map((y) => [s, { x: s.x, y }, { x: t.x, y }, t]),
  ];
  const score = (pts: Vec[]) =>
    pts.slice(1).reduce((sum, p, i) => {
      const q = pts[i];
      const hits = obstacles.reduce(
        (n, r) =>
          n +
          Number(
            Math.min(q.x, p.x) < r.maxX + 8 &&
              Math.max(q.x, p.x) > r.minX - 8 &&
              Math.min(q.y, p.y) < r.maxY + 8 &&
              Math.max(q.y, p.y) > r.minY - 8,
          ),
        0,
      );
      return sum + Math.hypot(p.x - q.x, p.y - q.y) + hits * 100000;
    }, 0);
  routes.sort((x, y) => score(x) - score(y));
  return [a, ...routes[0], b]
    .filter(
      (p, i, arr) =>
        !i || Math.hypot(p.x - arr[i - 1].x, p.y - arr[i - 1].y) > 0.01,
    )
    .map((p) => ({ x: p.x - a.x, y: p.y - a.y }));
}
export function copyElements(
  elements: SceneElement[],
  dx: number,
  dy: number,
): SceneElement[] {
  const ids = new Map(elements.map((e) => [e.id, crypto.randomUUID()])),
    groups = new Map<string, string>();
  return elements.map((e) => {
    if (e.groupId && !groups.has(e.groupId))
      groups.set(e.groupId, crypto.randomUUID());
    const binding = (b: Binding | undefined) =>
      b && ids.has(b.elementId)
        ? { ...b, elementId: ids.get(b.elementId)! }
        : undefined;
    return {
      ...e,
      id: ids.get(e.id)!,
      x: e.x + dx,
      y: e.y + dy,
      locked: false,
      createdAt: Date.now(),
      groupId: e.groupId ? groups.get(e.groupId) : undefined,
      startBinding: binding(e.startBinding),
      endBinding: binding(e.endBinding),
      link: e.link
        ? {
            ...e.link,
            elementId:
              e.link.path === "" && e.link.elementId
                ? (ids.get(e.link.elementId) ?? e.link.elementId)
                : e.link.elementId,
          }
        : undefined,
    };
  });
}
