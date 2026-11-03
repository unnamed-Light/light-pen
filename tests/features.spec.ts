import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
const shape = (id: string, x: number, y: number) => ({
  id,
  kind: "rectangle" as const,
  x,
  y,
  width: 160,
  height: 120,
  color: "#0f6cbd",
  fill: "#cfe9fd",
  strokeWidth: 3,
  opacity: 1,
  createdAt: Date.now(),
});
async function seed(page: Page, elements: unknown[] = []) {
  await page.evaluate((elements) => {
    const e = window.__LIGHT_PEN_TEST__!.editor;
    e.setDocument({
      ...e.document,
      schemaVersion: 2,
      id: crypto.randomUUID(),
      revision: 0,
      elements: elements as typeof e.elements,
    });
    e.setCamera({ x: 0, y: 0, zoom: 1 });
    e.snap = false;
    e.setTool("select");
  }, elements);
}
async function drag(page: Page, x: number, y: number, ex: number, ey: number) {
  const b = (await page.getByTestId("board").boundingBox())!;
  await page.mouse.move(b.x + x, b.y + y);
  await page.mouse.down();
  await page.mouse.move(b.x + ex, b.y + ey, { steps: 20 });
  await page.mouse.up();
}
async function select(page: Page, ids: string[]) {
  await page.evaluate((ids) => {
    const e = window.__LIGHT_PEN_TEST__!.editor;
    e.selected = new Set(ids);
    e.emit("ui");
    e.emit("overlay");
  }, ids);
}
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await seed(page);
});
test("text slider, exact numeric sizes and formatting are editable and persist", async ({
  page,
}, info) => {
  await seed(page, [
    {
      ...shape("text", 430, 200),
      kind: "text",
      text: "Текст собственного размера",
      fontSize: 24,
      width: 450,
      height: 80,
    },
  ]);
  await select(page, ["text"]);
  const size = page.getByRole("spinbutton", { name: "Размер текста, число" });
  await size.fill("47");
  await size.press("Enter");
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements[0].fontSize,
    ),
  ).toBe(47);
  await page.getByRole("button", { name: "Жирный", exact: true }).click();
  await page.getByRole("button", { name: "Курсив", exact: true }).click();
  await page
    .getByRole("button", { name: "Текст по центру", exact: true })
    .click();
  const slider = page.getByRole("slider", {
    name: "Размер текста",
    exact: true,
  });
  await slider.focus();
  await slider.press("End");
  await expect(size).toHaveValue("256");
  await page.keyboard.press("Control+z");
  await expect(size).toHaveValue("47");
  await page.getByLabel("Стандартный размер текста").selectOption("64");
  await expect(size).toHaveValue("64");
  await page.evaluate(() => window.__LIGHT_PEN_TEST__!.saver.flush());
  await page.reload();
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  expect(
    await page.evaluate(() => {
      const e = window.__LIGHT_PEN_TEST__!.editor.elements[0];
      return [e.fontSize, e.bold, e.italic, e.textAlign];
    }),
  ).toEqual([64, true, true, "center"]);
  await page.screenshot({ path: info.outputPath("text-formatting.png") });
});
test("dragging font size creates one undo transaction and does not flood document revisions", async ({
  page,
}) => {
  await seed(page, [
    { ...shape("t", 430, 200), kind: "text", text: "Ползунок", fontSize: 24 },
  ]);
  await select(page, ["t"]);
  const slider = page.getByRole("slider", {
      name: "Размер текста",
      exact: true,
    }),
    b = (await slider.boundingBox())!;
  await page.mouse.move(b.x + 10, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width - 5, b.y + b.height / 2, { steps: 35 });
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.document.revision,
    ),
  ).toBe(0);
  await page.mouse.up();
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.document.revision,
    ),
  ).toBe(1);
  await page.keyboard.press("Control+z");
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements[0].fontSize,
    ),
  ).toBe(24);
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.history.canUndo,
    ),
  ).toBe(false);
});
test("connected arrows follow live movement, resize and reload", async ({
  page,
}, info) => {
  await seed(page, [shape("a", 420, 220), shape("b", 900, 360)]);
  await page
    .getByRole("button", { name: "Соединитель (C)", exact: true })
    .click();
  await drag(page, 575, 280, 905, 420);
  expect(
    await page.evaluate(
      () =>
        window.__LIGHT_PEN_TEST__!.editor.elements[2].startBinding?.elementId,
    ),
  ).toBe("a");
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements[2].endBinding?.elementId,
    ),
  ).toBe("b");
  await page
    .getByRole("button", { name: "Выделение (V)", exact: true })
    .click();
  await drag(page, 470, 260, 530, 320);
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.elements[2].x),
  ).toBeCloseTo(641.5);
  await select(page, ["b"]);
  await drag(page, 1061.5, 481.5, 1120, 530);
  await page.evaluate(() => window.__LIGHT_PEN_TEST__!.saver.flush());
  const before = await page.evaluate(
    () => window.__LIGHT_PEN_TEST__!.editor.elements,
  );
  await page.reload();
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.elements),
  ).toEqual(before);
  await page.screenshot({ path: info.outputPath("connected-diagram.png") });
});
test("group, context menu, locking and unlock retain exact undo", async ({
  page,
}) => {
  await seed(page, [shape("a", 420, 220), shape("b", 690, 360)]);
  await select(page, ["a", "b"]);
  await page.getByRole("button", { name: "Группа", exact: true }).click();
  await page.evaluate(() => {
    const e = window.__LIGHT_PEN_TEST__!.editor;
    e.selected.clear();
    e.emit("ui");
  });
  await drag(page, 470, 270, 510, 310);
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.selection.length,
    ),
  ).toBe(2);
  const b = (await page.getByTestId("board").boundingBox())!;
  await page.mouse.click(b.x + 510, b.y + 310, { button: "right" });
  await expect(
    page.getByRole("menu", { name: "Контекстное меню доски" }),
  ).toBeVisible();
  await page.getByRole("menuitem", { name: "Закрепить", exact: true }).click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements.length,
    ),
  ).toBe(2);
  await page.mouse.click(b.x + 510, b.y + 310, { button: "right" });
  await page
    .getByRole("menuitem", { name: "Разблокировать всё", exact: true })
    .click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements.length,
    ),
  ).toBe(0);
  await page.keyboard.press("Control+z");
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements.length,
    ),
  ).toBe(2);
});
test("alignment menu preserves group spacing and distributes independent objects", async ({
  page,
}) => {
  await seed(page, [
    shape("a", 380, 220),
    shape("b", 650, 360),
    shape("c", 1040, 480),
  ]);
  await select(page, ["a", "b", "c"]);
  await page.getByRole("button", { name: "Выровнять", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "По верхнему краю", exact: true })
    .click();
  expect(
    await page.evaluate(() =>
      window.__LIGHT_PEN_TEST__!.editor.elements.map((e) => e.y),
    ),
  ).toEqual([220, 220, 220]);
  await page.getByRole("button", { name: "Выровнять", exact: true }).click();
  await page
    .getByRole("menuitem", {
      name: "Равные интервалы по горизонтали",
      exact: true,
    })
    .click();
  expect(
    await page.evaluate(() =>
      window.__LIGHT_PEN_TEST__!.editor.elements.map((e) => e.x),
    ),
  ).toEqual([380, 710, 1040]);
});
test("frames navigate, move contents and export a cropped PNG", async ({
  page,
}) => {
  await seed(page, [shape("a", 500, 320), shape("outside", 1180, 600)]);
  await page
    .getByRole("button", { name: "Другие инструменты", exact: true })
    .click();
  await page.getByRole("button", { name: "Фрейм", exact: true }).click();
  await drag(page, 380, 200, 1000, 600);
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements[0].kind,
    ),
  ).toBe("frame");
  await page
    .getByRole("button", { name: "Выделение (V)", exact: true })
    .click();
  await drag(page, 410, 210, 450, 250);
  expect(
    await page.evaluate(
      () =>
        window.__LIGHT_PEN_TEST__!.editor.elements.find((e) => e.id === "a")!.x,
    ),
  ).toBe(540);
  await page.getByRole("button", { name: "Фреймы доски", exact: true }).click();
  await expect(
    page.getByRole("complementary", { name: "Фреймы", exact: true }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Экспорт фрейма Фрейм", exact: true })
    .click();
  expect((await download).suggestedFilename()).toMatch(/\.png$/);
  const image = await page.evaluate(async () => {
    const e = window.__LIGHT_PEN_TEST__!.editor,
      r = window.__LIGHT_PEN_TEST__!.renderer!;
    const result = await r.exportPng(false, e.elements[0].id);
    return [result.width, result.height];
  });
  expect(image).toEqual([1368, 928]);
});
test("search finds Unicode notes and formula source without editing the board", async ({
  page,
}) => {
  await seed(page, [
    {
      ...shape("t", 10000, 10000),
      kind: "sticky",
      fontSize: 24,
      text: "План 日本語 запуск",
    },
    {
      ...shape("f", 20000, 20000),
      kind: "math",
      fontSize: 24,
      text: String.raw`\int_0^1 x dx`,
    },
  ]);
  const before = await page.evaluate(
    () => window.__LIGHT_PEN_TEST__!.editor.document.revision,
  );
  await page.keyboard.press("Control+f");
  const search = page.getByRole("textbox", { name: "Поисковый запрос" });
  await search.fill("日本語");
  await page.locator(".navigation-item").click();
  expect(
    await page.evaluate(() => [...window.__LIGHT_PEN_TEST__!.editor.selected]),
  ).toEqual(["t"]);
  await search.fill(String.raw`\int`);
  await page.locator(".navigation-item").click();
  expect(
    await page.evaluate(() => [...window.__LIGHT_PEN_TEST__!.editor.selected]),
  ).toEqual(["f"]);
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.document.revision,
    ),
  ).toBe(before);
});
test("version history checkpoints, restores and preserves the state being replaced", async ({
  page,
}) => {
  await seed(page, [shape("a", 420, 220)]);
  await page
    .getByRole("button", { name: "История версий", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Создать снимок сейчас", exact: true })
    .click();
  await expect(page.locator(".version-list .navigation-item")).toHaveCount(1);
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.evaluate(() => {
    const e = window.__LIGHT_PEN_TEST__!.editor;
    e.selected.add("a");
    e.deleteSelection();
  });
  await page
    .getByRole("button", { name: "История версий", exact: true })
    .click();
  await page.locator(".version-list .navigation-item").click();
  await page
    .getByRole("button", { name: "Восстановить выбранную", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements.length,
    ),
  ).toBe(1);
  await page
    .getByRole("button", { name: "История версий", exact: true })
    .click();
  await expect(page.locator(".version-list .navigation-item")).toHaveCount(2);
});
test("LaTeX formula supports preview, correction, editing, persistence and PNG offline", async ({
  page,
}, info) => {
  await page.route(/https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  await page
    .getByRole("button", { name: "Другие инструменты", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Формула LaTeX", exact: true })
    .click();
  const b = (await page.getByTestId("board").boundingBox())!;
  await page.mouse.click(b.x + 500, b.y + 240);
  const source = page.getByRole("textbox", { name: "Исходный LaTeX" });
  await source.fill(String.raw`\frac{a`);
  await expect(
    page.getByRole("button", { name: "Применить формулу" }),
  ).toBeDisabled();
  await source.fill(String.raw`\frac{-b\pm\sqrt{b^2-4ac}}{2a}`);
  await expect(page.locator(".formula-preview img")).toBeVisible();
  await page.screenshot({ path: info.outputPath("latex-editor.png") });
  await page.getByRole("button", { name: "Применить формулу" }).click();
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements[0].kind,
    ),
  ).toBe("math");
  const result = await page.evaluate(async () => {
    const result = await window.__LIGHT_PEN_TEST__!.renderer!.exportPng();
    const img = new Image();
    img.src = result.dataUrl;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] < 200) ink++;
    return { ink, width: img.width };
  });
  expect(result.ink).toBeGreaterThan(100);
  await page.evaluate(() => window.__LIGHT_PEN_TEST__!.saver.flush());
  await page.reload();
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await page.evaluate(() => {
    const e = window.__LIGHT_PEN_TEST__!.editor;
    e.setCamera({ x: 0, y: 0, zoom: 1 });
  });
  await page
    .getByRole("button", { name: "Выделение (V)", exact: true })
    .click();
  await page.mouse.dblclick(b.x + 520, b.y + 250);
  await expect(source).toHaveValue(String.raw`\frac{-b\pm\sqrt{b^2-4ac}}{2a}`);
  await page.getByRole("button", { name: "Матрица", exact: true }).click();
  await expect(page.locator(".formula-preview img")).toBeVisible();
  await page.getByRole("button", { name: "Применить формулу" }).click();
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements.length,
    ),
  ).toBe(1);
});
test("clipboard image paste embeds a real image and custom colors remain available", async ({
  page,
}) => {
  await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 40;
    c.height = 30;
    c.getContext("2d")!.fillRect(0, 0, 40, 30);
    const data = atob(c.toDataURL().split(",")[1]),
      bytes = Uint8Array.from(data, (c) => c.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([bytes], "clipboard.png", { type: "image/png" }),
    );
    window.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: transfer }),
    );
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.elements[0]?.kind),
    )
    .toBe("image");
  await page.getByRole("button", { name: "Перо (P)", exact: true }).click();
  const hex = page.getByRole("textbox", { name: "Код цвета", exact: true });
  await hex.fill("#125a9f");
  await hex.press("Enter");
  await expect(
    page.getByRole("button", { name: "Последний цвет #125a9f", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await expect(
    page.getByRole("button", { name: "Последний цвет #125a9f", exact: true }),
  ).toBeVisible();
});
test("pen settings persist and new strokes capture their own parameters", async ({
  page,
}, info) => {
  await page
    .getByRole("button", { name: "Настройки пера", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Аккуратный контур", exact: true })
    .click();
  const slider = page.getByRole("slider", { name: "Сглаживание", exact: true });
  await slider.focus();
  await slider.press("End");
  await page.screenshot({ path: info.outputPath("pen-settings.png") });
  await page.getByRole("button", { name: "Готово", exact: true }).click();
  await page.getByRole("button", { name: "Перо (P)", exact: true }).click();
  await drag(page, 430, 300, 900, 450);
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements[0].ink,
    ),
  ).toEqual({ smoothing: 100, stabilization: 55, minWidth: 40, pressure: 100 });
  await page.evaluate(() => window.__LIGHT_PEN_TEST__!.saver.flush());
  await page.reload();
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.pen.stabilization,
    ),
  ).toBe(55);
});
test("connector end handles can change attachment targets and undo", async ({
  page,
}) => {
  await seed(page, [
    shape("a", 420, 200),
    shape("b", 850, 220),
    shape("c", 850, 520),
  ]);
  await page
    .getByRole("button", { name: "Соединитель (C)", exact: true })
    .click();
  await drag(page, 575, 260, 855, 280);
  await page
    .getByRole("button", { name: "Выделение (V)", exact: true })
    .click();
  await select(page, [
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.elements[3].id),
  ]);
  await drag(page, 848.5, 280, 855, 580);
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements[3].endBinding?.elementId,
    ),
  ).toBe("c");
  await page.keyboard.press("Control+z");
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements[3].endBinding?.elementId,
    ),
  ).toBe("b");
});
test("invalid formula data shows a failure and cannot silently export an empty formula", async ({
  page,
}) => {
  await seed(page, [
    {
      ...shape("m", 450, 250),
      kind: "math",
      fontSize: 24,
      text: String.raw`\notAValidCommand{x}`,
    },
  ]);
  const message = await page.evaluate(async () => {
    try {
      await window.__LIGHT_PEN_TEST__!.renderer!.exportPng();
      return "success";
    } catch (e) {
      return String(e);
    }
  });
  expect(message).toContain("Не удалось отрисовать формулу");
});
test("new panels and dialog actions remain reachable in the minimum window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 560 });
  await page
    .getByRole("button", { name: "Настройки пера", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Готово", exact: true }),
  ).toBeInViewport();
  await page.getByRole("button", { name: "Готово", exact: true }).click();
  await page
    .getByRole("button", { name: "История версий", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Закрыть", exact: true }),
  ).toBeInViewport();
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page
    .getByRole("button", { name: "Другие инструменты", exact: true })
    .click();
  await page.getByRole("button", { name: "Формула LaTeX", exact: true }).click();
  const b = (await page.getByTestId("board").boundingBox())!;
  await page.mouse.click(b.x + 430, b.y + 200);
  await page.getByRole("button", { name: "Дробь", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Применить формулу", exact: true }),
  ).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "Применить формулу", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Применить формулу", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Поиск по доске", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Поисковый запрос", exact: true }),
  ).toBeInViewport();
  await page
    .getByRole("button", { name: "Закрыть панель", exact: true })
    .click();
});
