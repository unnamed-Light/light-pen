import { test, expect } from "vitest";
import { ValidationPool } from "./validation-pool";
import { SharedBoard } from "../src/collaboration/shared";
import {
  createDocument,
  createElement,
  DEFAULT_STYLE,
} from "../src/editor/model/types";
test("worker cache cannot retain a rejected candidate or an update that was never durably committed", async () => {
  const pool = new ValidationPool(1),
    source = new SharedBoard();
  const document = {
    ...createDocument(),
    elements: [
      {
        ...createElement("rectangle", 0, 0, DEFAULT_STYLE),
        width: 100,
        height: 100,
      },
    ],
  };
  source.seed(document);
  const initial = source.encode(),
    input = { state: initial, room: document.id, maxState: 64 * 1024 * 1024 };
  const patch = (shared: SharedBoard, extra: Record<string, unknown>) => {
    const before = shared.snapshot();
    shared.patch(before, {
      ...before,
      elements: before.elements.map((e) => ({ ...e, ...extra })),
    });
  };
  try {
    patch(source, { x: 10 });
    const first = await pool.run({ ...input, update: source.encode() });
    const poison = new SharedBoard();
    poison.apply(first.state);
    poison.meta.set("id", "other-room");
    await expect(
      pool.run({ ...input, state: first.state, update: poison.encode() }),
    ).rejects.toThrow(/идентификатор/);
    poison.destroy();
    patch(source, { y: 20 });
    const next = await pool.run({
      ...input,
      state: first.state,
      update: source.encode(),
    });
    const checked = new SharedBoard();
    checked.apply(next.state);
    expect(checked.snapshot().elements[0]).toMatchObject({ x: 10, y: 20 });
    checked.destroy();
    // Pretend the result above could not be written. Authoritative bytes are still initial.
    const alternative = new SharedBoard();
    alternative.apply(initial);
    patch(alternative, { fill: "#fff1a8" });
    const rolledBack = await pool.run({
      ...input,
      update: alternative.encode(),
    });
    const result = new SharedBoard();
    result.apply(rolledBack.state);
    expect(result.snapshot().elements[0]).toMatchObject({
      x: 0,
      y: 0,
      fill: "#fff1a8",
    });
    alternative.destroy();
    result.destroy();
  } finally {
    source.destroy();
    await pool.close();
  }
});
