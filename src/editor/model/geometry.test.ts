import { describe, expect, it } from "vitest";
import {
  bounds,
  distanceToSegment,
  hitTest,
  resizeElement,
  screenToWorld,
  segmentDistance,
  sweepHitTest,
  unionBounds,
  worldToScreen,
  zoomAt,
} from "./geometry";
import { createElement, DEFAULT_STYLE } from "./types";

describe("camera coordinates", () => {
  it("round trips at extreme scales and negative coordinates", () => {
    for (const zoom of [0.05, 0.1, 0.75, 1, 2, 8])
      for (const x of [-1e6, -100, 0, 100, 1e6]) {
        const camera = { x: 125.25, y: -718.8, zoom },
          p = { x, y: x * 0.7 };
        const result = screenToWorld(worldToScreen(p, camera), camera);
        expect(result.x).toBeCloseTo(p.x, 5);
        expect(result.y).toBeCloseTo(p.y, 5);
      }
  });
  it("keeps the world point under the zoom anchor even at limits", () => {
    for (const factor of [0.00001, 0.7, 1.2, 1e6]) {
      const c = { x: -120, y: 230, zoom: 1.6 },
        anchor = { x: 713, y: 318 };
      const before = screenToWorld(anchor, c),
        after = screenToWorld(anchor, zoomAt(c, anchor, factor));
      expect(after.x).toBeCloseTo(before.x);
      expect(after.y).toBeCloseTo(before.y);
    }
  });
});
describe("geometry and picking", () => {
  it("handles taps, reverse arrows and negative local stroke points", () => {
    const stroke = {
      ...createElement("stroke", 100, 100, DEFAULT_STYLE),
      points: [
        [-30, 50, 0.5, 0],
        [20, -10, 0.8, 10],
      ] as [number, number, number, number][],
    };
    expect(bounds(stroke)).toEqual({
      minX: 67,
      minY: 87,
      maxX: 123,
      maxY: 153,
    });
    expect(hitTest(stroke, { x: 70, y: 150 }, 2)).toBe(true);
    expect(hitTest(stroke, { x: 80, y: 90 }, 2)).toBe(false);
    const arrow = {
      ...createElement("arrow", 100, 100, DEFAULT_STYLE),
      endX: -80,
      endY: -40,
      width: 80,
      height: 40,
    };
    expect(hitTest(arrow, { x: 60, y: 80 }, 2)).toBe(true);
  });
  it("picks outlines and filled shapes correctly", () => {
    for (const kind of ["rectangle", "ellipse", "diamond"] as const) {
      const e = {
        ...createElement(kind, 0, 0, DEFAULT_STYLE),
        width: 100,
        height: 80,
      };
      expect(hitTest(e, { x: 50, y: 40 }, 1)).toBe(false);
      expect(hitTest({ ...e, fill: "#fff1a8" }, { x: 50, y: 40 }, 1)).toBe(
        true,
      );
      expect(hitTest(e, { x: 50, y: -1 }, 3)).toBe(true);
    }
  });
  it("rescales points and arrow endpoints without mutating originals", () => {
    const e = {
      ...createElement("stroke", 0, 0, DEFAULT_STYLE),
      width: 10,
      height: 10,
      points: [
        [0, 0, 0.2, 0],
        [10, 10, 0.8, 100],
      ] as [number, number, number, number][],
    };
    const result = resizeElement(
      e,
      { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      { minX: 20, minY: 30, maxX: 40, maxY: 60 },
    );
    expect(result.points?.[1]).toEqual([20, 30, 0.8, 100]);
    expect(e.points[1][0]).toBe(10);
    expect(result.x).toBe(20);
  });
  it("handles a degenerate segment and empty scene", () => {
    expect(
      distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 }),
    ).toBe(5);
    expect(unionBounds([])).toBeNull();
  });
  it("continuous erasure catches crossings without erasing empty shape interiors", () => {
    const line = {
      ...createElement("line", 200, 0, DEFAULT_STYLE),
      endX: 0,
      endY: 200,
      width: 0,
      height: 200,
    };
    expect(sweepHitTest(line, { x: 0, y: 100 }, { x: 500, y: 100 }, 2)).toBe(
      true,
    );
    const rect = {
      ...createElement("rectangle", 0, 0, DEFAULT_STYLE),
      width: 200,
      height: 200,
    };
    expect(sweepHitTest(rect, { x: 50, y: 50 }, { x: 150, y: 150 }, 2)).toBe(
      false,
    );
    expect(sweepHitTest(rect, { x: -30, y: 100 }, { x: 250, y: 100 }, 2)).toBe(
      true,
    );
    expect(
      segmentDistance(
        { x: 0, y: 0 },
        { x: 100, y: 100 },
        { x: 0, y: 100 },
        { x: 100, y: 0 },
      ),
    ).toBe(0);
  });
});
