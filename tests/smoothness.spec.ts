import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await page.evaluate(() => {
    const { editor } = window.__LIGHT_PEN_TEST__!,
      now = new Date().toISOString();
    editor.setDocument({
      schemaVersion: 1,
      id: crypto.randomUUID(),
      title: "Плавность линий",
      revision: 0,
      createdAt: now,
      updatedAt: now,
      elements: [],
    });
    editor.setCamera({ x: 0, y: 0, zoom: 1 });
    editor.grid = false;
    editor.setStyle({ strokeWidth: 6 });
    editor.emit("scene");
  });
});

test("active and committed curves have matching silhouettes, continuous ink and bounded tails", async ({
  page,
}, testInfo) => {
  const results = await page.evaluate(async () => {
    const { editor, renderer } = window.__LIGHT_PEN_TEST__!;
    const wait = () =>
      new Promise<void>((r) => requestAnimationFrame(() => r()));
    const capture = () => {
      const main = document.querySelector<HTMLCanvasElement>(".board-canvas")!,
        overlay = document.querySelector<HTMLCanvasElement>(".board-overlay")!,
        c = document.createElement("canvas");
      c.width = main.width;
      c.height = main.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(main, 0, 0);
      ctx.globalAlpha = Number(overlay.style.opacity) || 1;
      ctx.drawImage(overlay, 0, 0);
      return ctx.getImageData(0, 0, c.width, c.height);
    };
    const results = [];
    for (const config of [
      { name: "slow-diagonal", count: 600, batch: 6, marker: false },
      { name: "fast-arcs", count: 180, batch: 18, marker: false },
      { name: "pressure-wave", count: 1400, batch: 32, marker: false },
      { name: "marker-curve", count: 1000, batch: 40, marker: true },
      {
        name: "steady-pressure",
        count: 1400,
        batch: 32,
        marker: false,
        pen: { smoothing: 75, stabilization: 55, minWidth: 20, pressure: 125 },
      },
      {
        name: "wide-pressure",
        count: 900,
        batch: 24,
        marker: false,
        pen: { smoothing: 40, stabilization: 25, minWidth: 75, pressure: 75 },
      },
    ]) {
      editor.setDocument({
        ...editor.document,
        id: crypto.randomUUID(),
        elements: [],
        revision: 0,
      });
      editor.setCamera({ x: 0, y: 0, zoom: 1 });
      editor.grid = false;
      editor.pen = config.pen ?? {
        smoothing: 60,
        stabilization: 12,
        minWidth: 40,
        pressure: 100,
      };
      editor.setTool(config.marker ? "highlighter" : "pen");
      await wait();
      await wait();
      const y = (x: number) =>
        config.name === "slow-diagonal"
          ? 240 + (x - 350) * 0.23
          : 320 + Math.sin((x - 350) / 90) * 65;
      editor.pointerDown(
        { x: 350, y: y(350) },
        23,
        { x: 350, y: y(350), pressure: 0.15, pointerType: "pen", time: 0 },
        0,
        false,
      );
      let maxTail = 0;
      for (let start = 1; start <= config.count; start += config.batch) {
        for (
          let i = start;
          i < Math.min(start + config.batch, config.count + 1);
          i++
        ) {
          const x = 350 + (i / config.count) * 600;
          editor.pointerMove(
            { x, y: y(x) },
            23,
            {
              x,
              y: y(x),
              pressure: config.name.includes("pressure")
                ? 0.12 + 0.8 * (0.5 + 0.5 * Math.sin(i * 0.012))
                : 0.5,
              pointerType: "pen",
              time: i * 2,
            },
            false,
          );
        }
        await wait();
        maxTail = Math.max(maxTail, renderer!.stats.inkTailPoints);
      }
      await wait();
      const before = capture();
      const activeTimes = renderer!.stats.overlaySamples.slice(
        -Math.ceil(config.count / config.batch),
      );
      editor.pointerUp(23);
      await wait();
      await wait();
      const after = capture();
      let ink = 0,
        changed = 0,
        gaps = 0;
      for (let i = 0; i < before.data.length; i += 4) {
        const isInk =
          before.data[i + 2] > before.data[i] + 30 ||
          after.data[i + 2] > after.data[i] + 30;
        if (isInk) {
          ink++;
          if (
            Math.max(
              Math.abs(before.data[i] - after.data[i]),
              Math.abs(before.data[i + 1] - after.data[i + 1]),
              Math.abs(before.data[i + 2] - after.data[i + 2]),
            ) > 25
          )
            changed++;
        }
      }
      for (let x = 360; x < 940; x++) {
        const expected = y(x);
        let found = false;
        for (
          let py = Math.floor(expected - 18);
          py <= Math.ceil(expected + 18);
          py++
        ) {
          const index = (py * after.width + x) * 4;
          if (after.data[index + 2] > after.data[index] + 25) {
            found = true;
            break;
          }
        }
        if (!found) gaps++;
      }
      const sorted = [...activeTimes].sort((a, b) => a - b);
      results.push({
        name: config.name,
        points: editor.elements[0].points!.length,
        silhouetteChange: changed / Math.max(1, ink),
        gaps,
        maxTail,
        overlayP95: sorted[Math.floor((sorted.length - 1) * 0.95)],
        commitPaint: renderer!.stats.lastMs,
      });
    }
    return results;
  });
  await testInfo.attach("line-smoothness", {
    body: JSON.stringify(results, null, 2),
    contentType: "application/json",
  });
  console.log("METRIC line-smoothness:", JSON.stringify(results));
  for (const result of results) {
    expect(
      result.silhouetteChange,
      `${result.name}: release jump`,
    ).toBeLessThan(0.04);
    expect(result.gaps, `${result.name}: gaps`).toBe(0);
    expect(result.maxTail).toBeLessThanOrEqual(528);
    expect(result.overlayP95).toBeLessThan(16.7);
    expect(result.commitPaint).toBeLessThan(16.7);
  }
  await page.screenshot({ path: testInfo.outputPath("smooth-marker.png") });
});

test("line width scales cleanly at 50%, 100%, 200% and 400%", async ({
  page,
}, testInfo) => {
  const widths = await page.evaluate(async () => {
    const { editor } = window.__LIGHT_PEN_TEST__!,
      wait = () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        );
    editor.setTool("pen");
    editor.pointerDown(
      { x: 350, y: 350 },
      1,
      { x: 350, y: 350, pressure: 0.5, pointerType: "pen", time: 0 },
      0,
      false,
    );
    for (let i = 1; i <= 600; i++)
      editor.pointerMove(
        { x: 350 + i, y: 350 },
        1,
        { x: 350 + i, y: 350, pressure: 0.5, pointerType: "pen", time: i },
        false,
      );
    editor.pointerUp(1);
    const result = [];
    for (const zoom of [0.5, 1, 2, 4]) {
      editor.setCamera({ zoom, x: 720 - 650 * zoom, y: 450 - 350 * zoom });
      await wait();
      const canvas =
          document.querySelector<HTMLCanvasElement>(".board-canvas")!,
        r = devicePixelRatio,
        data = canvas
          .getContext("2d")!
          .getImageData(
            Math.round(720 * r),
            Math.round(400 * r),
            1,
            Math.round(100 * r),
          ).data;
      let width = 0;
      for (let i = 0; i < data.length; i += 4)
        if (data[i + 2] > data[i] + 30) width++;
      result.push({ zoom, width: width / r });
    }
    return result;
  });
  console.log("METRIC zoom-line-width:", JSON.stringify(widths));
  await testInfo.attach("zoom-line-width", {
    body: JSON.stringify(widths),
    contentType: "application/json",
  });
  for (const result of widths) {
    expect(result.width).toBeGreaterThanOrEqual(6 * result.zoom * 0.7);
    expect(result.width).toBeLessThanOrEqual(6 * result.zoom * 1.4 + 2);
  }
  await page.screenshot({ path: testInfo.outputPath("smooth-line-400.png") });
});

test("tooltip portals do not cover the canvas and unnamed boards stay accessible", async ({
  page,
}) => {
  const pen = page.getByRole("button", { name: "Перо (P)", exact: true });
  await pen.hover();
  await page.waitForTimeout(600);
  expect(
    await page.evaluate(() =>
      document.elementFromPoint(700, 450)?.getAttribute("data-testid"),
    ),
  ).toBe("board");
  const canvas = await page.getByTestId("board").boundingBox();
  await page.mouse.move(canvas!.x + 400, canvas!.y + 300);
  await page.mouse.down();
  await page.mouse.move(canvas!.x + 700, canvas!.y + 350, { steps: 30 });
  await page.mouse.up();
  const title = page.getByRole("textbox", { name: "Название доски" });
  await title.fill("Вернуться к этой доске");
  await title.press("Enter");
  await page.evaluate(() => window.__LIGHT_PEN_TEST__!.saver.flush());
  const id = await page.evaluate(
    () => window.__LIGHT_PEN_TEST__!.editor.document.id,
  );
  await page.getByRole("button", { name: "Меню файла" }).click();
  await page.getByRole("menuitem", { name: "Новая доска" }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.elements.length),
    )
    .toBe(0);
  await page.getByRole("button", { name: "Меню файла" }).click();
  await page.getByRole("menuitem", { name: "Недавние доски…" }).click();
  await page.getByRole("button", { name: /Вернуться к этой доске/ }).click();
  await expect
    .poll(() =>
      page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.document.id),
    )
    .toBe(id);
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements.length,
    ),
  ).toBe(1);
});
