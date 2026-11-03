import { expect, test } from "@playwright/test";

test("large scene cache updates after object edits, theme, grid and camera changes", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  const result = await page.evaluate(async () => {
    const { editor, renderer } = window.__LIGHT_PEN_TEST__!,
      now = new Date().toISOString(),
      wait = () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        );
    editor.setDocument({
      schemaVersion: 1,
      id: crypto.randomUUID(),
      title: "Cache QA",
      revision: 0,
      createdAt: now,
      updatedAt: now,
      elements: Array.from({ length: 2500 }, (_, i) => ({
        id: `box-${i}`,
        kind: "rectangle" as const,
        x: (i % 50) * 100,
        y: Math.floor(i / 50) * 80,
        width: 70,
        height: 50,
        color: "#242424",
        fill: "#0f6cbd",
        strokeWidth: 2,
        opacity: 1,
        createdAt: Date.now(),
      })),
    });
    editor.fit();
    editor.grid = false;
    editor.emit("scene");
    await wait();
    await renderer!.measure(3);
    const index = 1275;
    const pixel = () => {
      const e = editor.elements[index],
        c = editor.camera,
        canvas = document.querySelector<HTMLCanvasElement>(".board-canvas")!,
        r = devicePixelRatio;
      const x = (e.x + e.width / 2) * c.zoom + c.x,
        y = (e.y + e.height / 2) * c.zoom + c.y;
      return [
        ...canvas
          .getContext("2d")!
          .getImageData(Math.round(x * r), Math.round(y * r), 1, 1).data,
      ];
    };
    const before = pixel();
    editor.setCamera({
      ...editor.camera,
      x: editor.camera.x + 23,
      y: editor.camera.y + 17,
    });
    await wait();
    const panned = pixel();
    editor.document = {
      ...editor.document,
      elements: editor.elements.map((e, i) =>
        i === index ? { ...e, fill: "#d13438" } : e,
      ),
    };
    editor.emit("scene");
    await wait();
    const edited = pixel();
    renderer!.setDark(true);
    await wait();
    const dark = pixel();
    editor.grid = true;
    editor.emit("scene");
    await wait();
    const grid = pixel();
    editor.zoom(1.4);
    await wait();
    const zoomed = pixel();
    return { before, panned, edited, dark, grid, zoomed };
  });
  expect(result.before[2]).toBeGreaterThan(result.before[0] + 100);
  expect(result.panned).toEqual(result.before);
  for (const p of [result.edited, result.dark, result.grid, result.zoomed])
    expect(p[0]).toBeGreaterThan(p[2] + 100);
});

test("coalesced pen events retain every pressure sample", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await page.evaluate(() => {
    const api = window.__LIGHT_PEN_TEST__!;
    api.editor.setDocument({
      ...api.editor.document,
      id: crypto.randomUUID(),
      elements: [],
      revision: 0,
    });
    api.editor.setCamera({ x: 0, y: 0, zoom: 1 });
    api.editor.setTool("pen");
  });
  const board = await page.getByTestId("board").boundingBox();
  await page.mouse.move(board!.x + 400, board!.y + 300);
  await page.mouse.down();
  const points = await page.evaluate(() => {
    const { editor } = window.__LIGHT_PEN_TEST__!,
      canvas = document.querySelector<HTMLCanvasElement>(".board-overlay")!,
      rect = canvas.getBoundingClientRect(),
      id = editor.gesture!.pointer;
    const event = new PointerEvent("pointermove", {
      pointerId: id,
      pointerType: "pen",
      clientX: rect.left + 500,
      clientY: rect.top + 320,
      pressure: 0.8,
      buttons: 1,
      bubbles: true,
    });
    Object.defineProperty(event, "getCoalescedEvents", {
      value: () =>
        Array.from(
          { length: 40 },
          (_, i) =>
            new PointerEvent("pointermove", {
              pointerId: id,
              pointerType: "pen",
              clientX: rect.left + 401 + i * 2.5,
              clientY: rect.top + 300 + i * 0.5,
              pressure: 0.1 + i * 0.02,
              buttons: 1,
            }),
        ),
    });
    canvas.dispatchEvent(event);
    return editor.gesture?.type === "ink"
      ? editor.gesture.element.points!.length
      : 0;
  });
  await page.mouse.up();
  expect(points).toBe(41);
});
