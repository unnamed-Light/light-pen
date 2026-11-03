import { expect, test } from "@playwright/test";
import type { Page, TestInfo } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

async function blank(page: Page) {
  await page.evaluate(() => {
    const api = window.__LIGHT_PEN_TEST__!,
      now = new Date().toISOString();
    api.editor.setDocument({
      schemaVersion: 1,
      id: crypto.randomUUID(),
      title: "Тестовая доска",
      revision: 0,
      createdAt: now,
      updatedAt: now,
      elements: [],
    });
    api.editor.setCamera({ x: 0, y: 0, zoom: 1 });
    api.editor.setTool("pen");
  });
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}
async function tool(page: Page, label: string) {
  const primary = page.getByRole("button", { name: label, exact: true });
  if (await primary.count()) await primary.click();
  else {
    await page
      .getByRole("button", { name: "Другие инструменты", exact: true })
      .click();
    await page
      .getByRole("button", {
        name: label.replace(/ \([A-Z]\)$/, ""),
        exact: true,
      })
      .click();
  }
}
async function at(page: Page, x: number, y: number) {
  const b = await page.getByTestId("board").boundingBox();
  return { x: x + b!.x, y: y + b!.y };
}
async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  steps = 20,
) {
  const a = await at(page, from.x, from.y),
    b = await at(page, to.x, to.y);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
}
async function scene(page: Page) {
  return page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.document);
}
async function frame(page: Page) {
  await page.evaluate(
    () =>
      new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}
const quantile = (array: number[], q: number) =>
  [...array].sort((a, b) => a - b)[Math.floor((array.length - 1) * q)];
async function metric(testInfo: TestInfo, name: string, value: unknown) {
  await testInfo.attach(name, {
    body: JSON.stringify(value, null, 2),
    contentType: "application/json",
  });
  console.log(`METRIC ${name}: ${JSON.stringify(value)}`);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await blank(page);
});

test("mouse ink is visible, incremental and one undo operation", async ({
  page,
}) => {
  const before = await page.evaluate(() => ({
    ...window.__LIGHT_PEN_TEST__!.renderer!.stats,
  }));
  const a = await at(page, 350, 300),
    b = await at(page, 900, 400);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 90 });
  expect((await scene(page)).elements).toHaveLength(0);
  await frame(page);
  const during = await page.evaluate(
    () => window.__LIGHT_PEN_TEST__!.renderer!.stats,
  );
  expect(during.mainFrames).toBe(before.mainFrames);
  expect(during.overlayFrames).toBeGreaterThan(before.overlayFrames);
  await page.mouse.up();
  await frame(page);
  const doc = await scene(page);
  expect(doc.elements).toHaveLength(1);
  expect(doc.elements[0].points!.length).toBeGreaterThan(50);
  const blue = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".board-canvas")!,
      r = devicePixelRatio;
    const d = c
      .getContext("2d")!
      .getImageData(
        Math.round(620 * r),
        Math.round(348 * r),
        Math.round(20 * r),
        Math.round(12 * r),
      ).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4)
      if (d[i + 2] > d[i] + 40 && d[i + 2] > d[i + 1]) ink++;
    return ink;
  });
  expect(blue).toBeGreaterThan(2);
  await page.keyboard.press("Control+z");
  expect((await scene(page)).elements).toHaveLength(0);
  await page.keyboard.press("Control+Shift+z");
  expect((await scene(page)).elements).toHaveLength(1);
});

test("synthetic pen pressure changes the saved samples and rendered width", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Толщина 12", exact: true }).click();
  const cdp = await page.context().newCDPSession(page),
    offset = await at(page, 0, 0);
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: offset.x + 360,
    y: offset.y + 320,
    button: "left",
    buttons: 1,
    clickCount: 1,
    pointerType: "pen",
    force: 0.08,
  });
  for (let i = 1; i <= 100; i++)
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: offset.x + 360 + i * 4,
      y: offset.y + 320,
      button: "left",
      buttons: 1,
      pointerType: "pen",
      force: 0.08 + i * 0.0085,
    });
  await cdp.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: offset.x + 760,
    y: offset.y + 320,
    button: "left",
    buttons: 0,
    clickCount: 1,
    pointerType: "pen",
    force: 0,
  });
  await frame(page);
  const pts = (await scene(page)).elements[0].points!;
  expect(pts[0][2]).toBeLessThan(0.15);
  expect(pts.at(-1)![2]).toBeGreaterThan(0.8);
  const widths = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".board-canvas")!,
      ctx = canvas.getContext("2d")!,
      r = devicePixelRatio;
    return [430, 680].map((x) => {
      const d = ctx.getImageData(
        Math.round(x * r),
        Math.round(300 * r),
        1,
        Math.round(40 * r),
      ).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 2] > d[i] + 40) n++;
      return n / r;
    });
  });
  expect(widths[1]).toBeGreaterThan(widths[0] + 2);
  await cdp.detach();
});

for (const [label, kind] of [
  ["Прямоугольник (R)", "rectangle"],
  ["Эллипс (O)", "ellipse"],
  ["Ромб (D)", "diamond"],
  ["Стрелка (A)", "arrow"],
  ["Линия (L)", "line"],
]) {
  test(`${kind} draws backwards with consistent geometry`, async ({ page }) => {
    await tool(page, label);
    await drag(page, { x: 850, y: 470 }, { x: 460, y: 260 });
    const element = (await scene(page)).elements[0];
    expect(element.kind).toBe(kind);
    expect(element.width).toBeCloseTo(390);
    expect(element.height).toBeCloseTo(210);
    await page.keyboard.press("Control+z");
    expect((await scene(page)).elements).toHaveLength(0);
    await page.keyboard.press("Control+Shift+z");
    expect((await scene(page)).elements[0]).toEqual(element);
  });
}

test("text and sticky support multiline Unicode, editing and cancel", async ({
  page,
}) => {
  await tool(page, "Текст (T)");
  await page.mouse.click(
    ...(Object.values(await at(page, 400, 230)) as [number, number]),
  );
  await page
    .getByRole("textbox", { name: "Текст объекта" })
    .fill("Привет, мир!\n日本語 ✨");
  await page.keyboard.press("Control+Enter");
  expect((await scene(page)).elements[0].text).toContain("日本語");
  await tool(page, "Стикер (N)");
  const p = await at(page, 800, 320);
  await page.mouse.click(p.x, p.y);
  await page
    .getByRole("textbox", { name: "Текст объекта" })
    .fill("Первая мысль\nВторая строка");
  await page.keyboard.press("Control+Enter");
  expect((await scene(page)).elements).toHaveLength(2);
  await tool(page, "Выделение (V)");
  const edit = await at(page, 850, 370);
  await page.mouse.dblclick(edit.x, edit.y);
  await page
    .getByRole("textbox", { name: "Текст объекта" })
    .fill("Это отменим");
  await page.keyboard.press("Escape");
  expect((await scene(page)).elements[1].text).toBe(
    "Первая мысль\nВторая строка",
  );
});

test("selection, resize, duplication, marquee and z-order retain exact undo", async ({
  page,
}) => {
  await tool(page, "Прямоугольник (R)");
  await page.getByText("Заливка", { exact: true }).click();
  await page
    .getByRole("button", { name: "Заливка #fff1a8", exact: true })
    .click();
  await drag(page, { x: 420, y: 240 }, { x: 620, y: 400 });
  await drag(page, { x: 760, y: 260 }, { x: 940, y: 430 });
  await tool(page, "Выделение (V)");
  await drag(page, { x: 500, y: 310 }, { x: 540, y: 340 });
  expect((await scene(page)).elements[0].x).toBeCloseTo(460);
  await page.keyboard.press("Control+z");
  expect((await scene(page)).elements[0].x).toBe(420);
  await drag(page, { x: 418.5, y: 238.5 }, { x: 380, y: 200 });
  expect((await scene(page)).elements[0].width).toBeGreaterThan(200);
  await page.keyboard.press("Control+z");
  await drag(page, { x: 340, y: 170 }, { x: 1020, y: 500 });
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.selected.size),
  ).toBe(2);
  await page.keyboard.press("Control+d");
  expect((await scene(page)).elements).toHaveLength(4);
  await page.keyboard.press("Delete");
  expect((await scene(page)).elements).toHaveLength(2);
  await page.keyboard.press("Control+z");
  expect((await scene(page)).elements).toHaveLength(4);
});

test("eraser sweep is a single undo step and cancellation is lossless", async ({
  page,
}) => {
  await drag(page, { x: 400, y: 300 }, { x: 550, y: 320 });
  await drag(page, { x: 700, y: 300 }, { x: 850, y: 320 });
  const original = (await scene(page)).elements;
  await tool(page, "Ластик (E)");
  await drag(page, { x: 350, y: 310 }, { x: 950, y: 310 }, 3);
  expect((await scene(page)).elements).toHaveLength(0);
  await page.keyboard.press("Control+z");
  expect((await scene(page)).elements).toEqual(original);
  const p = await at(page, 450, 307);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect((await scene(page)).elements).toEqual(original);
});

test("camera zoom stays anchored and hand/space gestures do not change document", async ({
  page,
}) => {
  await drag(page, { x: 400, y: 300 }, { x: 650, y: 380 });
  const original = await scene(page),
    p = await at(page, 900, 450);
  await page.mouse.move(p.x, p.y);
  await page.mouse.wheel(0, -200);
  await frame(page);
  const camera = await page.evaluate(
    () => window.__LIGHT_PEN_TEST__!.editor.camera,
  );
  expect((900 - camera.x) / camera.zoom).toBeCloseTo(900);
  expect((450 - camera.y) / camera.zoom).toBeCloseTo(450);
  await page.keyboard.down("Space");
  await drag(page, { x: 600, y: 500 }, { x: 740, y: 560 });
  await page.keyboard.up("Space");
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.camera.x),
  ).toBeCloseTo(camera.x + 140);
  expect(await scene(page)).toEqual(original);
});

test("pointer cancellation and lost capture do not commit ghost strokes", async ({
  page,
}) => {
  const a = await at(page, 400, 300);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 100, a.y + 30);
  const id = await page.evaluate(
    () => window.__LIGHT_PEN_TEST__!.editor.gesture!.pointer,
  );
  await page
    .getByTestId("board")
    .dispatchEvent("pointercancel", { pointerId: id, pointerType: "mouse" });
  await page.mouse.up();
  expect((await scene(page)).elements).toHaveLength(0);
});

test("autosave restores exact document after reload", async ({ page }) => {
  await drag(page, { x: 400, y: 300 }, { x: 800, y: 450 });
  await tool(page, "Стикер (N)");
  const p = await at(page, 700, 200);
  await page.mouse.click(p.x, p.y);
  await page
    .getByRole("textbox", { name: "Текст объекта" })
    .fill("Сохраним это\n圧力 ✨");
  await page.keyboard.press("Control+Enter");
  await page
    .getByRole("textbox", { name: "Название доски" })
    .fill("Моя доска 日本語");
  await page.getByRole("textbox", { name: "Название доски" }).press("Enter");
  await page.evaluate(() => window.__LIGHT_PEN_TEST__!.saver.flush());
  const before = await scene(page);
  await page.reload();
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  expect(await scene(page)).toEqual(before);
  expect(await page.getByTestId("save-status").innerText()).toContain(
    "сохранён",
  );
});

test("title Escape cancels rename and tool keys do not hijack text entry", async ({
  page,
}) => {
  const title = page.getByRole("textbox", { name: "Название доски" });
  await title.fill("Не сохранять");
  await title.press("Escape");
  expect((await scene(page)).title).toBe("Тестовая доска");
  await tool(page, "Текст (T)");
  const p = await at(page, 430, 300);
  await page.mouse.click(p.x, p.y);
  await page
    .getByRole("textbox", { name: "Текст объекта" })
    .pressSequentially("pen RHOVE");
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.tool),
  ).toBe("text");
  await page.keyboard.press("Control+Enter");
  expect((await scene(page)).elements[0].text).toBe("pen RHOVE");
});

test("image import and PNG export produce a real nonempty image", async ({
  page,
}, testInfo) => {
  const png = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 40;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#d13438";
    ctx.fillRect(0, 0, 64, 40);
    return c.toDataURL("image/png").split(",")[1];
  });
  await page.getByTestId("image-input").setInputFiles({
    name: "Тест.png",
    mimeType: "image/png",
    buffer: Buffer.from(png, "base64"),
  });
  await expect.poll(async () => (await scene(page)).elements.length).toBe(1);
  expect((await scene(page)).elements[0].kind).toBe("image");
  await page.getByRole("button", { name: "Меню файла" }).click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Экспортировать PNG…" }).click();
  const download = await downloadPromise;
  const file = testInfo.outputPath("export.png");
  await download.saveAs(file);
  const bytes = await readFile(file);
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  expect(bytes.readUInt32BE(16)).toBeGreaterThan(64);
  expect(bytes.readUInt32BE(20)).toBeGreaterThan(40);
});

test("replay supports pause, seek, speed and leaves the document unchanged", async ({
  page,
}) => {
  await drag(page, { x: 400, y: 300 }, { x: 700, y: 360 }, 40);
  await drag(page, { x: 400, y: 410 }, { x: 700, y: 470 }, 40);
  const before = await scene(page);
  await page
    .getByRole("button", { name: "Воспроизвести доску", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Пауза", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Пауза", exact: true }).click();
  const progress = await page.evaluate(
    () => window.__LIGHT_PEN_TEST__!.editor.replay!.progress,
  );
  await page.waitForTimeout(200);
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.replay!.progress,
    ),
  ).toBe(progress);
  await page.getByRole("slider", { name: "Позиция воспроизведения" }).focus();
  await page.keyboard.press("End");
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.replay!.progress,
    ),
  ).toBeGreaterThan(0.95);
  await page.getByRole("button", { name: "Закрыть воспроизведение" }).click();
  expect(await scene(page)).toEqual(before);
});

test("Fluent layout remains usable in both themes and compact HiDPI windows", async ({
  page,
  browser,
}, testInfo) => {
  await page.getByRole("button", { name: "Меню файла" }).click();
  await page.getByRole("menuitem", { name: "Открыть пример" }).click();
  await frame(page);
  await page.screenshot({ path: testInfo.outputPath("fluent-desktop.png") });
  await page.getByRole("button", { name: "Переключить тему" }).click();
  await frame(page);
  await page.screenshot({
    path: testInfo.outputPath("fluent-desktop-alternate.png"),
  });
  const context = await browser.newContext({
    viewport: { width: 900, height: 650 },
    deviceScaleFactor: 1.5,
  });
  const compact = await context.newPage();
  await compact.goto("/");
  await expect(compact.getByTestId("app")).toHaveAttribute(
    "data-ready",
    "true",
  );
  await frame(compact);
  const size = await compact.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".board-canvas")!;
    return {
      canvasWidth: c.width,
      cssWidth: c.clientWidth,
      overflow: document.documentElement.scrollWidth > innerWidth,
      ratio: devicePixelRatio,
    };
  });
  expect(size.ratio).toBe(1.5);
  expect(size.canvasWidth).toBe(Math.round(size.cssWidth * 1.5));
  expect(size.overflow).toBe(false);
  await expect(
    compact.getByRole("button", { name: "Стикер (N)", exact: true }),
  ).toBeInViewport();
  await compact.screenshot({
    path: testInfo.outputPath("fluent-compact-hidpi.png"),
  });
  await context.close();
});

test("1000/10000-object scenes cull offscreen objects and meet measured CPU budgets", async ({
  page,
}, testInfo) => {
  const results = [];
  for (const count of [1000, 10_000]) {
    await page.evaluate((count) => {
      const api = window.__LIGHT_PEN_TEST__!,
        now = new Date().toISOString();
      api.editor.setDocument({
        schemaVersion: 1,
        id: crypto.randomUUID(),
        title: "Нагрузка",
        revision: 0,
        createdAt: now,
        updatedAt: now,
        elements: Array.from({ length: count }, (_, i) => ({
          id: `shape-${i}`,
          kind: i % 3 === 0 ? "ellipse" : "rectangle",
          x: (i % 100) * 150,
          y: Math.floor(i / 100) * 100,
          width: 110,
          height: 65,
          color: "#0f6cbd",
          fill: i % 2 ? "transparent" : "#cfe9fd",
          strokeWidth: 2,
          opacity: 1,
          createdAt: Date.now(),
        })),
      });
      api.editor.setCamera({ x: 0, y: 0, zoom: 1 });
    }, count);
    await frame(page);
    const measured = await page.evaluate(async () => {
      const r = window.__LIGHT_PEN_TEST__!.renderer!;
      return { samples: await r.measure(45), visible: r.stats.visible };
    });
    const normalP95 = quantile(measured.samples, 0.95);
    expect(measured.visible).toBeLessThan(200);
    expect(normalP95).toBeLessThan(16.7);
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.fit());
    await frame(page);
    const fit = await page.evaluate(async () => {
      const r = window.__LIGHT_PEN_TEST__!.renderer!;
      const coldMs = r.stats.lastMs;
      const phases = { ...r.lastPhases };
      const samples: number[] = [];
      const editor = window.__LIGHT_PEN_TEST__!.editor,
        base = { ...editor.camera };
      for (let i = 0; i < 30; i++) {
        editor.setCamera({ ...base, x: base.x + i * 0.7, y: base.y + i * 0.2 });
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        samples.push(r.stats.lastMs);
      }
      return {
        samples,
        coldMs,
        phases,
        visible: r.stats.visible,
        zoom: window.__LIGHT_PEN_TEST__!.editor.camera.zoom,
      };
    });
    const fitP95 = quantile(fit.samples, 0.95);
    console.log(
      "COLD-PROFILE",
      JSON.stringify({ count, cold: fit.coldMs, phases: fit.phases, fitP95 }),
    );
    expect(fitP95).toBeLessThan(16.7);
    // One-time preparation of a 10k-object overview has a separate 100 ms budget.
    expect(fit.coldMs).toBeLessThan(100);
    results.push({
      count,
      normalVisible: measured.visible,
      normalP95,
      fitVisible: fit.visible,
      fitP95,
      coldFitMs: fit.coldMs,
      fitZoom: fit.zoom,
    });
  }
  await metric(testInfo, "scene-performance", results);
  await writeFile(
    testInfo.outputPath("performance.json"),
    JSON.stringify(results, null, 2),
  );
  const before = await page.evaluate(
    () => window.__LIGHT_PEN_TEST__!.renderer!.stats.mainFrames,
  );
  await page.waitForTimeout(350);
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.renderer!.stats.mainFrames,
    ),
  ).toBe(before);
});

test("10000-sample live ink avoids scene repaints and stays within frame budget", async ({
  page,
}, testInfo) => {
  const result = await page.evaluate(async () => {
    const { editor, renderer } = window.__LIGHT_PEN_TEST__!;
    editor.setTool("pen");
    const before = renderer!.stats.mainFrames;
    const batches: number[] = [];
    editor.pointerDown(
      { x: 380, y: 300 },
      17,
      { x: 380, y: 300, pressure: 0.2, pointerType: "pen", time: 0 },
      0,
      false,
    );
    for (let start = 1; start < 10_000; start += 100) {
      const t = performance.now();
      for (let i = start; i < Math.min(start + 100, 10_000); i++) {
        const x = 380 + (i % 800) * 0.7,
          y = 300 + Math.sin(i * 0.02) * 120;
        editor.pointerMove(
          { x, y },
          17,
          {
            x,
            y,
            pressure: 0.1 + (i % 100) / 120,
            pointerType: "pen",
            time: i,
          },
          false,
        );
      }
      batches.push(performance.now() - t);
      await new Promise((r) => requestAnimationFrame(r));
    }
    const sceneRepaints = renderer!.stats.mainFrames - before,
      overlay = renderer!.stats.overlaySamples.slice(-100);
    editor.pointerUp(17);
    await new Promise((r) =>
      requestAnimationFrame(() => requestAnimationFrame(r)),
    );
    return {
      batches,
      overlay,
      sceneRepaints,
      points: editor.elements[0].points!.length,
      commitPaint: renderer!.stats.lastMs,
    };
  });
  await metric(testInfo, "long-ink-performance", {
    points: result.points,
    handlerBatchP95: quantile(result.batches, 0.95),
    overlayP95: quantile(result.overlay, 0.95),
    commitPaint: result.commitPaint,
    sceneRepaints: result.sceneRepaints,
  });
  expect(result.sceneRepaints).toBe(0);
  expect(result.points).toBeGreaterThan(9900);
  expect(quantile(result.batches, 0.95)).toBeLessThan(8);
  expect(quantile(result.overlay, 0.95)).toBeLessThan(16.7);
  expect(result.commitPaint).toBeLessThan(16.7);
});
