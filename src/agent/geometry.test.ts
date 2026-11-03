import { describe, expect, it } from "vitest";
import { AgentController } from "./controller";
import { Editor } from "../editor/editor";
import { connectorPoints } from "../editor/model/connectors";
import type { SceneElement } from "../editor/model/types";

function setup() {
  const editor = new Editor();
  const agent = new AgentController(editor);
  agent.enable({
    session: "geometry-session",
    write: true,
    files: false,
    network: false,
  });
  const create = (elements: Partial<SceneElement>[]) =>
    agent.call("edit_batch", {
      session: agent.grant!.session,
      requestId: crypto.randomUUID(),
      documentId: editor.document.id,
      expectedRevision: editor.document.revision,
      operations: [{ op: "create", elements }],
    });
  return { editor, create };
}

describe("Agent connector geometry", () => {
  it.each(["line", "arrow"] as const)(
    "%s defaults to size-relative endpoints away from the origin",
    async (kind) => {
      const { editor, create } = setup();
      await create([
        { id: "positive", kind, x: 100, y: 200, width: 80, height: 30 },
        { id: "negative", kind, x: -300, y: -120, width: 80, height: 30 },
      ]);
      for (const element of editor.elements) {
        expect(element.endX).toBe(80);
        expect(element.endY).toBe(30);
        const points = connectorPoints(element);
        expect(points[0]).toEqual({ x: 0, y: 0 });
        expect(points.at(-1)).toEqual({ x: 80, y: 30 });
        expect({
          x: element.x + points.at(-1)!.x,
          y: element.y + points.at(-1)!.y,
        }).toEqual({ x: element.x + 80, y: element.y + 30 });
      }
      // Both connectors form one user operation, including their geometry.
      editor.undo();
      expect(editor.elements).toHaveLength(0);
      editor.redo();
      expect(editor.elements.map((el) => [el.endX, el.endY])).toEqual([
        [80, 30],
        [80, 30],
      ]);
    },
  );

  it.each(["line", "arrow"] as const)(
    "%s preserves explicit reverse endpoint offsets",
    async (kind) => {
      const { editor, create } = setup();
      await create([
        {
          kind,
          x: 420,
          y: 250,
          width: 80,
          height: 30,
          endX: -80,
          endY: -30,
        },
      ]);
      const element = editor.elements[0];
      expect(connectorPoints(element).at(-1)).toEqual({ x: -80, y: -30 });
      expect([element.x + element.endX!, element.y + element.endY!]).toEqual([
        340, 220,
      ]);
    },
  );

  it("keeps orthogonal unbound endpoints at the requested world positions", async () => {
    const { editor, create } = setup();
    await create([
      {
        kind: "arrow",
        x: 100,
        y: 200,
        width: 80,
        height: 30,
        connectorStyle: "orthogonal",
      },
    ]);
    const element = editor.elements[0];
    expect(element.width).toBe(80);
    expect(element.height).toBe(30);
    const points = connectorPoints(element);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points.at(-1)).toEqual({ x: 80, y: 30 });
    for (let i = 1; i < points.length; i++) {
      expect(
        points[i].x === points[i - 1].x || points[i].y === points[i - 1].y,
      ).toBe(true);
    }
  });
});
