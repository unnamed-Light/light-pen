import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
const shape = (
  id: string,
  x = 440,
  y = 200,
  extra: Record<string, unknown> = {},
) => ({
  id,
  kind: "rectangle",
  x,
  y,
  width: 180,
  height: 120,
  color: "#0f6cbd",
  fill: "#cfe9fd",
  strokeWidth: 3,
  opacity: 1,
  createdAt: Date.now(),
  ...extra,
});
async function seed(page: Page, elements: unknown[] = []) {
  await page.evaluate((elements) => {
    const e = window.__LIGHT_PEN_TEST__!.editor;
    e.setDocument({
      ...e.document,
      id: crypto.randomUUID(),
      schemaVersion: 3,
      revision: 0,
      title: "Студия тестов",
      elements: elements as typeof e.elements,
    });
    e.setCamera({ x: 0, y: 0, zoom: 1 });
    e.snap = false;
    e.setTool("select");
  }, elements);
}
async function select(page: Page, ids: string[]) {
  await page.evaluate((ids) => {
    const e = window.__LIGHT_PEN_TEST__!.editor;
    e.selected = new Set(ids);
    e.dock = "properties";
    e.emit("ui");
    e.emit("overlay");
  }, ids);
}
async function scene(page: Page) {
  return page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.document);
}
async function insert(page: Page, label: string) {
  await page
    .getByRole("button", { name: "Вставить объект", exact: true })
    .click();
  await page.getByRole("button", { name: label, exact: true }).click();
}
async function pointer(page: Page, x: number, y: number) {
  const r = (await page.getByTestId("board").boundingBox())!;
  return { x: r.x + x, y: r.y + y };
}
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await seed(page);
});

test("one dock transitions between properties, layers, insertion, frames and templates without overlaps", async ({
  page,
}, info) => {
  await seed(page, [shape("one")]);
  await select(page, ["one"]);
  await expect(
    page.getByRole("complementary", { name: "Свойства инструмента" }),
  ).toBeVisible();
  for (const [button, panel] of [
    ["Объекты и слои", "Объекты и слои"],
    ["Вставить объект", "Вставка"],
    ["Фреймы доски", "Фреймы"],
    ["Библиотека шаблонов", "Шаблоны"],
  ]) {
    await page.getByRole("button", { name: button, exact: true }).click();
    await expect(
      page.getByRole("complementary", { name: panel, exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("complementary")).toHaveCount(1);
  }
  await page
    .getByRole("button", { name: "Вставить объект", exact: true })
    .click();
  await page.screenshot({ path: info.outputPath("fluent-insert.png") });
  await page.setViewportSize({ width: 800, height: 560 });
  await expect(
    page.getByRole("button", { name: "Таблица", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Таблица", exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("button", { name: "Таблица", exact: true }),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
});
test("object layer controls rename, reorder, hide and lock with exact undo and persistence", async ({
  page,
}) => {
  await seed(page, [
    shape("a", 420, 200, { name: "Основа" }),
    shape("b", 660, 200, { name: "Карточка" }),
  ]);
  const original = await scene(page);
  await page
    .getByRole("button", { name: "Объекты и слои", exact: true })
    .click();
  const name = page.getByRole("textbox", {
    name: "Имя объекта b",
    exact: true,
  });
  await name.fill("План проекта");
  await name.press("Enter");
  await page
    .getByRole("button", { name: "Скрыть План проекта", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Закрепить План проекта", exact: true })
    .click();
  await page.getByRole("button", { name: "Опустить b", exact: true }).click();
  let doc = await scene(page);
  expect(doc.elements[0]).toMatchObject({
    id: "b",
    name: "План проекта",
    hidden: true,
    locked: true,
  });
  await page.evaluate(() => window.__LIGHT_PEN_TEST__!.saver.flush());
  await page.reload();
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  expect((await scene(page)).elements).toEqual(doc.elements);
  await page
    .getByRole("button", { name: "Объекты и слои", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Показать План проекта", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Открепить План проекта", exact: true })
    .click();
  await page.getByTestId("board").focus();
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+z");
  doc = await scene(page);
  expect(doc.elements[0].hidden).toBe(true);
  expect(doc.elements[0].locked).toBe(true);
  expect(original.elements[0].id).toBe("a");
});
test("numeric rotation and group rotation handle are exact undo operations", async ({
  page,
}) => {
  await seed(page, [shape("a"), shape("b", 700, 200, { groupId: "group" })]);
  await select(page, ["a"]);
  const angle = page.getByRole("spinbutton", {
    name: "Поворот числом",
    exact: true,
  });
  await angle.fill("35");
  await angle.press("Enter");
  expect((await scene(page)).elements[0].rotation).toBe(35);
  await page.getByTestId("board").focus();
  await page.keyboard.press("Control+z");
  expect((await scene(page)).elements[0].rotation).toBeUndefined();
  await select(page, ["a", "b"]);
  const b = await page.evaluate(
    () => window.__LIGHT_PEN_TEST__!.editor.selectionBounds!,
  );
  const start = await pointer(page, (b.minX + b.maxX) / 2, b.minY - 28),
    end = await pointer(page, b.maxX + 40, (b.minY + b.maxY) / 2);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.keyboard.down("Shift");
  await page.mouse.move(end.x, end.y, { steps: 20 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  expect((await scene(page)).elements.map((e) => e.rotation)).toEqual([90, 90]);
  await page.getByTestId("board").focus();
  await page.keyboard.press("Control+z");
  expect(
    (await scene(page)).elements.every((e) => e.rotation === undefined),
  ).toBe(true);
});
test("full palette offers HSV, RGB, favorite colors and a single undo for opacity", async ({
  page,
}, info) => {
  await seed(page, [shape("a")]);
  await select(page, ["a"]);
  await page
    .getByRole("button", { name: "Полная палитра", exact: true })
    .click();
  const red = page.getByRole("spinbutton", { name: "Цвет R", exact: true });
  await red.fill("180");
  await red.press("Tab");
  await page
    .getByRole("button", { name: "В избранные цвета", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Избранный цвет #b4/ }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("fluent-palette.png") });
  await page.keyboard.press("Escape");
  await page.getByTestId("board").focus();
  const opacity = page.getByRole("slider", {
    name: "Непрозрачность",
    exact: true,
  });
  const before = (await scene(page)).revision;
  await opacity.focus();
  await page.keyboard.down("ArrowLeft");
  await page.keyboard.up("ArrowLeft");
  expect((await scene(page)).elements[0].opacity).toBeLessThan(1);
  expect((await scene(page)).revision).toBe(before + 1);
  await page.getByTestId("board").focus();
  await page.keyboard.press("Control+z");
  expect((await scene(page)).elements[0].opacity).toBe(1);
});
test("connectors switch routes, label, move attachments and export their visible path", async ({
  page,
}) => {
  await seed(page, [
    shape("a", 400, 200),
    shape("b", 900, 360),
    shape("edge", 580, 260, {
      kind: "arrow",
      width: 320,
      height: 160,
      endX: 320,
      endY: 160,
      startBinding: { elementId: "a", side: "right" },
      endBinding: { elementId: "b", side: "left" },
    }),
  ]);
  await select(page, ["edge"]);
  const style = page.getByRole("combobox", {
    name: "Вид соединителя",
    exact: true,
  });
  await style.selectOption("curve");
  const label = page.getByRole("textbox", {
    name: "Подпись соединителя",
    exact: true,
  });
  await label.fill("Следующий шаг");
  await label.press("Enter");
  expect((await scene(page)).elements[2].label).toBe("Следующий шаг");
  await style.selectOption("orthogonal");
  expect((await scene(page)).elements[2].route!.length).toBeGreaterThan(2);
  await page.evaluate(() => {
    const e = window.__LIGHT_PEN_TEST__!.editor;
    e.patchElement("b", { y: 500 });
  });
  const doc = await scene(page);
  expect(doc.elements[2].endY).toBeGreaterThan(200);
  const svg = await page.evaluate(async () => {
    const modulePath = "/src/editor/render/vector-export.ts";
    const { exportSvg } = await import(modulePath);
    return (await exportSvg(window.__LIGHT_PEN_TEST__!.editor.document)).svg;
  });
  expect(svg).toContain("Следующий шаг");
  expect(svg).toContain("<polyline");
});
test("local template library survives reload, transfers a file, and remaps all inserted IDs", async ({
  page,
}, info) => {
  await seed(page, [
    shape("one", 440, 200, { groupId: "g" }),
    shape("two", 680, 200, {
      groupId: "g",
      link: { path: "", elementId: "one" },
    }),
  ]);
  await select(page, ["one", "two"]);
  const source = await scene(page);
  await page.evaluate(async () => {
    const a = window.__LIGHT_PEN_TEST__!;
    a.saver.schedule(a.editor.document);
    await a.saver.flush();
  });
  await page
    .getByRole("button", {
      name: "Сохранить выделение как шаблон…",
      exact: true,
    })
    .click();
  await page
    .getByRole("textbox", { name: "Название шаблона", exact: true })
    .fill("Мой фрагмент");
  await page
    .getByRole("button", { name: "Сохранить шаблон", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: /Мой фрагмент 2 объектов/ }),
  ).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт…", exact: true }).click();
  const download = await downloadPromise;
  const path = info.outputPath("fragment.lightpen-template");
  await download.saveAs(path);
  const exported = JSON.parse(await readFile(path, "utf8"));
  expect(exported.elements).toEqual(source.elements);
  await page.reload();
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await page
    .getByRole("button", { name: "Библиотека шаблонов", exact: true })
    .click();
  await page.getByRole("button", { name: /Мой фрагмент 2 объектов/ }).click();
  const after = await scene(page);
  expect(after.elements).toHaveLength(4);
  expect(new Set(after.elements.map((e) => e.id)).size).toBe(4);
  expect(after.elements[3].link!.elementId).toBe(after.elements[2].id);
  await page
    .getByRole("button", { name: "Библиотека шаблонов", exact: true })
    .click();
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Импорт…", exact: true }).click();
  await (await chooser).setFiles(path);
  await expect(
    page.getByRole("button", { name: /Мой фрагмент 2 объектов/ }),
  ).toHaveCount(2);
});
test("editable table accepts Excel ranges and structural edits, cancels safely, saves and reopens", async ({
  page,
}, info) => {
  await insert(page, "Таблица");
  await page
    .getByRole("textbox", { name: "Название объекта", exact: true })
    .fill("План работ");
  const cell = page.getByRole("textbox", { name: "Ячейка 2, 2", exact: true });
  await cell.focus();
  await cell.evaluate((el) => {
    const data = new DataTransfer();
    data.setData("text/plain", 'Имя\tЗаметка\r\nИра\t"две\nстроки"\r\n');
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(
    page.getByRole("textbox", { name: "Ячейка 3, 3", exact: true }),
  ).toHaveValue("две\nстроки");
  await page.getByRole("button", { name: "+ Строка", exact: true }).click();
  await page.getByRole("button", { name: "+ Столбец", exact: true }).click();
  await page.screenshot({ path: info.outputPath("table-editor.png") });
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  let doc = await scene(page);
  expect(doc.elements[0].cells).toHaveLength(4);
  expect(doc.elements[0].cells![0]).toHaveLength(4);
  await page
    .getByRole("button", { name: "Редактировать таблицу…", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Ячейка 1, 1", exact: true })
    .fill("Отменённое изменение");
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  expect((await scene(page)).elements).toEqual(doc.elements);
  await page.evaluate(() => window.__LIGHT_PEN_TEST__!.saver.flush());
  await page.reload();
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  expect((await scene(page)).elements).toEqual(doc.elements);
});
test("task cards retain due date and status and checkboxes toggle on canvas with undo", async ({
  page,
}) => {
  await insert(page, "Задача / чек-лист");
  await page
    .getByRole("textbox", { name: "Название объекта", exact: true })
    .fill("Проверить бету");
  await page
    .getByRole("combobox", { name: "Статус задачи", exact: true })
    .selectOption("doing");
  await page.getByLabel("Срок задачи", { exact: true }).fill("2026-11-09");
  await page
    .getByRole("textbox", { name: "Пункт 1", exact: true })
    .fill("Открыть доску");
  await page
    .getByRole("button", { name: "Добавить пункт", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Пункт 2", exact: true })
    .fill("Проверить перо");
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  let doc = await scene(page);
  const task = doc.elements[0];
  expect(task.task).toMatchObject({ status: "doing", due: "2026-11-09" });
  const p = await pointer(page, task.x + 25, task.y + 88);
  await page.mouse.click(p.x, p.y);
  expect(
    (await scene(page)).elements[0].task!.items.map((i) => i.done),
  ).toEqual([true, false]);
  await page.getByTestId("board").focus();
  await page.keyboard.press("Control+z");
  expect((await scene(page)).elements).toEqual(doc.elements);
});
test("links focus a local object, missing targets report an error without replacing work", async ({
  page,
}) => {
  await seed(page, [shape("target", 1800, 1200, { name: "Цель" })]);
  await insert(page, "Локальная ссылка");
  await page
    .getByRole("textbox", { name: "Подпись ссылки", exact: true })
    .fill("К цели");
  await page
    .getByRole("combobox", { name: "Объект назначения", exact: true })
    .selectOption("target");
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await page
    .getByRole("button", { name: "Открыть ссылку", exact: true })
    .click();
  expect(
    await page.evaluate(() => [...window.__LIGHT_PEN_TEST__!.editor.selected]),
  ).toEqual(["target"]);
  const doc = await scene(page);
  await page.evaluate(() => {
    const e = window.__LIGHT_PEN_TEST__!.editor;
    e.linkRequest = { path: "", elementId: "missing" };
    e.emit("ui");
  });
  await expect(page.getByText(/Объект по ссылке не найден/)).toBeVisible();
  expect(await scene(page)).toEqual(doc);
});
test("minimap click and drag navigate a large scene without modifying the document", async ({
  page,
}) => {
  await seed(page, [shape("one", 500, 300), shape("far", 5000, 3000)]);
  const doc = await scene(page),
    before = await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.camera,
    );
  await page.getByRole("button", { name: "Миникарта", exact: true }).click();
  const map = page.getByRole("application", {
      name: "Навигация по миникарте",
      exact: true,
    }),
    r = (await map.boundingBox())!;
  await page.mouse.click(r.x + r.width * 0.8, r.y + r.height * 0.8);
  await page.mouse.move(r.x + r.width * 0.8, r.y + r.height * 0.8);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width * 0.65, r.y + r.height * 0.65, {
    steps: 10,
  });
  await page.mouse.up();
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.camera),
  ).not.toEqual(before);
  expect(await scene(page)).toEqual(doc);
});
test("software keyboard without physical codes controls tools, search, grouping and presentation", async ({
  page,
}) => {
  await seed(page, [
    shape("software-a", 400, 150, {
      kind: "frame",
      text: "План",
      fontSize: 20,
      width: 600,
      height: 420,
    }),
    shape("software-b", 1200, 150, {
      kind: "frame",
      text: "Итог",
      fontSize: 20,
      width: 600,
      height: 420,
    }),
    shape("item-a", 500, 250),
    shape("item-b", 750, 250),
  ]);
  const send = async (
    key: string,
    keyCode = 0,
    ctrlKey = false,
    type = "keydown",
  ) => {
    await page.evaluate(
      ({ key, keyCode, ctrlKey, type }) => {
        document.querySelector('[data-testid="board"]')!.dispatchEvent(
          new KeyboardEvent(type, {
            key,
            keyCode,
            ctrlKey,
            code: "",
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      { key, keyCode, ctrlKey, type },
    );
  };
  await send("з", 80);
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.tool),
  ).toBe("pen");
  await send("v", 86);
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.tool),
  ).toBe("select");
  await send("f", 70, true);
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.dock),
  ).toBe("search");
  await send("Escape", 27);
  await select(page, ["item-a", "item-b"]);
  await send("g", 71, true);
  let items = (await scene(page)).elements.filter((e) =>
    e.id.startsWith("item-"),
  );
  expect(items[0].groupId).toBeTruthy();
  expect(items[0].groupId).toBe(items[1].groupId);
  await send("z", 90, true);
  items = (await scene(page)).elements.filter((e) => e.id.startsWith("item-"));
  expect(items.every((e) => !e.groupId)).toBe(true);
  await send(" ", 32);
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.spaceHeld),
  ).toBe(true);
  await send(" ", 32, false, "keyup");
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.spaceHeld),
  ).toBe(false);
  const documentBefore = await scene(page);
  const cameraBefore = await page.evaluate(
    () => window.__LIGHT_PEN_TEST__!.editor.camera,
  );
  await send("F5", 116);
  await expect(page.getByLabel("Презентация", { exact: true })).toBeVisible();
  await send("ArrowRight", 39);
  await expect(page.getByText("2 / 2 · Итог", { exact: true })).toBeVisible();
  await send("Escape", 27);
  await expect(page.getByLabel("Презентация", { exact: true })).toBeHidden();
  expect(await scene(page)).toEqual(documentBefore);
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.camera),
  ).toEqual(cameraBefore);
});

test("frame presentation hides chrome, navigates, draws temporary notes and restores the camera", async ({
  page,
}, info) => {
  await seed(page, [
    shape("slide-a", 400, 150, {
      kind: "frame",
      text: "План",
      fontSize: 20,
      width: 600,
      height: 420,
      slideOrder: 1,
    }),
    shape("slide-b", 1200, 150, {
      kind: "frame",
      text: "Результат",
      fontSize: 20,
      width: 600,
      height: 420,
      slideOrder: 0,
    }),
    shape("item", 500, 250),
  ]);
  const doc = await scene(page),
    camera = await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.camera,
    );
  await page.getByTestId("board").focus();
  await page.keyboard.press("F5");
  await expect(page.getByLabel("Презентация", { exact: true })).toBeVisible();
  await expect(
    page.getByText("1 / 2 · Результат", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("toolbar")).toBeHidden();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByText("2 / 2 · План", { exact: true })).toBeVisible();
  await page
    .getByRole("combobox", { name: "Указатель презентации", exact: true })
    .selectOption("ink");
  await page.mouse.move(650, 320);
  await page.mouse.down();
  await page.mouse.move(850, 420, { steps: 40 });
  await page.mouse.up();
  await expect(page.locator(".presentation-input polyline")).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("presentation.png") });
  expect(await scene(page)).toEqual(doc);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("toolbar")).toBeVisible();
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.camera),
  ).toEqual(camera);
  expect(await scene(page)).toEqual(doc);
});
test("SVG and PDF export preserve rotated objects, Cyrillic text, formula paths and ordered frame pages", async ({
  page,
}, info) => {
  await seed(page, [
    shape("f1", 400, 150, {
      kind: "frame",
      text: "Первая",
      fontSize: 20,
      width: 600,
      height: 420,
      slideOrder: 0,
    }),
    shape("f2", 1200, 150, {
      kind: "frame",
      text: "Вторая",
      fontSize: 20,
      width: 600,
      height: 420,
      slideOrder: 1,
    }),
    shape("text", 460, 240, {
      kind: "text",
      text: "Проверка кириллицы",
      fontSize: 24,
      width: 420,
      height: 90,
      rotation: 12,
    }),
    shape("math", 500, 350, {
      kind: "math",
      text: String.raw`\frac{a}{b}+\int_0^1 x^2\,dx`,
      fontSize: 28,
      width: 260,
      height: 100,
    }),
    shape("table", 1250, 230, {
      kind: "table",
      text: "Данные",
      fontSize: 18,
      width: 420,
      height: 180,
      cells: [
        ["Этап", "Статус"],
        ["Тест", "Готово"],
      ],
    }),
    shape("hidden", 2000, 150, {
      kind: "text",
      text: "СКРЫТЫЙ ТЕКСТ",
      fontSize: 24,
      hidden: true,
    }),
  ]);
  await page
    .getByRole("button", { name: "Экспорт доски", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Формат экспорта", exact: true })
    .selectOption("svg");
  let promise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Экспортировать", exact: true })
    .click();
  let download = await promise;
  const svgPath = info.outputPath("vector.svg");
  await download.saveAs(svgPath);
  const svg = await readFile(svgPath, "utf8");
  expect(svg).toContain("Проверка кириллицы");
  expect(svg).not.toContain("СКРЫТЫЙ ТЕКСТ");
  expect(svg).toContain("rotate(12");
  expect(svg).toContain("data:font/ttf;base64");
  expect(svg).toContain("data-mml-node");
  await page
    .getByRole("button", { name: "Экспорт доски", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Область экспорта", exact: true })
    .selectOption("slides");
  promise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Экспортировать", exact: true })
    .click();
  download = await promise;
  const pdfPath = info.outputPath("frames.pdf");
  await download.saveAs(pdfPath);
  const pdf = await readFile(pdfPath);
  expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
  expect(pdf.toString("latin1").match(/\/Type \/Page\b/g)).toHaveLength(2);
  const report = JSON.parse(
    execFileSync(
      "python",
      [
        "-c",
        "from pypdf import PdfReader;import sys,json;r=PdfReader(sys.argv[1]);print(json.dumps({'pages':len(r.pages),'text':[p.extract_text() for p in r.pages]},ensure_ascii=True))",
        pdfPath,
      ],
      { encoding: "utf8" },
    ),
  );
  expect(report.text[0]).toContain("Проверка кириллицы");
  expect(report.text[1]).toContain("Готово");
  await writeFile(
    info.outputPath("pdf-content.json"),
    JSON.stringify(report, null, 2),
  );
  execFileSync("pdftoppm", [
    "-f",
    "1",
    "-singlefile",
    "-scale-to",
    "1300",
    "-png",
    pdfPath,
    info.outputPath("pdf-preview"),
  ]);
});

test("an existing shape can carry an editable local link and undo restores its original data", async ({
  page,
}) => {
  await seed(page, [
    shape("source", 440, 200, { name: "Источник" }),
    shape("target", 900, 450, { name: "Назначение" }),
  ]);
  await select(page, ["source"]);
  await page
    .getByRole("button", { name: "Добавить ссылку…", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Подпись ссылки", exact: true })
    .fill("Связанный объект");
  await page
    .getByRole("combobox", { name: "Объект назначения", exact: true })
    .selectOption("target");
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  const source = (await scene(page)).elements[0];
  expect(source.kind).toBe("rectangle");
  expect(source.width).toBe(180);
  expect(source.link!.elementId).toBe("target");
  await page
    .getByRole("button", { name: "Изменить ссылку…", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Убрать ссылку", exact: true })
    .click();
  expect((await scene(page)).elements[0].link).toBeUndefined();
  await page.getByTestId("board").focus();
  await page.keyboard.press("Control+z");
  expect((await scene(page)).elements[0]).toEqual(source);
});
test("overview of ten thousand mixed objects stays responsive with the minimap open", async ({
  page,
}, info) => {
  await seed(
    page,
    Array.from({ length: 10000 }, (_, i) =>
      shape(
        `mixed-${i}`,
        (i % 100) * 150,
        Math.floor(i / 100) * 110,
        i % 3 === 0
          ? {
              kind: "table",
              text: "Данные",
              fontSize: 18,
              cells: [
                ["Этап", "Срок"],
                ["Тест", "Сегодня"],
              ],
            }
          : i % 3 === 1
            ? {
                kind: "task",
                text: "Задача",
                fontSize: 18,
                task: {
                  status: "todo",
                  items: [{ id: "one", text: "Проверка", done: false }],
                },
              }
            : {
                kind: "text",
                text: "Большая доска",
                fontSize: 20,
                fill: "transparent",
              },
      ),
    ),
  );
  await page.getByRole("button", { name: "Миникарта", exact: true }).click();
  const measured = await page.evaluate(async () => {
    const a = window.__LIGHT_PEN_TEST__!;
    a.editor.fit();
    await new Promise<void>((r) =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())),
    );
    const cold = a.renderer!.stats.lastMs;
    const phases = { ...a.renderer!.lastPhases };
    const samples = await a.renderer!.measure(35);
    const start = performance.now();
    for (let i = 0; i < 25; i++) {
      a.editor.setCamera({ ...a.editor.camera, x: a.editor.camera.x + 2 });
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }
    return {
      cold,
      phases,
      samples,
      visible: a.renderer!.stats.visible,
      totalNavigationMs: performance.now() - start,
    };
  });
  const sorted = measured.samples.sort((a, b) => a - b),
    p95 = sorted[Math.floor(sorted.length * 0.95)];
  console.log(
    "METRIC mixed-overview:",
    JSON.stringify({ ...measured, samples: undefined, p95 }),
  );
  await writeFile(
    info.outputPath("mixed-performance.json"),
    JSON.stringify({ ...measured, p95 }, null, 2),
  );
  expect(p95).toBeLessThan(16.7);
  expect(measured.cold).toBeLessThan(100);
  expect(measured.visible).toBe(10000);
});
test("rotated frame exports clip vector and PNG contents and a bad formula aborts SVG export", async ({
  page,
}) => {
  await seed(page, [
    shape("frame", 400, 200, {
      kind: "frame",
      text: "Повернутый фрейм",
      fontSize: 20,
      width: 500,
      height: 350,
      rotation: 25,
    }),
    shape("inside", 500, 300, { kind: "text", text: "Внутри", fontSize: 24 }),
    shape("far", 2000, 2000),
  ]);
  const result = await page.evaluate(async () => {
    const modulePath = "/src/editor/render/vector-export.ts",
      { exportSvg } = await import(modulePath);
    const a = window.__LIGHT_PEN_TEST__!;
    const svg = await exportSvg(a.editor.document, {
      frameId: "frame",
      embedFonts: false,
    });
    const png = await a.renderer!.exportPng(false, "frame");
    return { svg, width: png.width, height: png.height };
  });
  expect(result.svg.svg).toContain('clipPath id="lpFrame"');
  expect(result.svg.svg).toContain("rotate(25");
  expect(result.width).toBeGreaterThan(1000);
  expect(result.height).toBeGreaterThan(700);
  await seed(page, [
    shape("bad", 500, 250, {
      kind: "math",
      text: String.raw`\frac{a`,
      fontSize: 24,
    }),
  ]);
  await page
    .getByRole("button", { name: "Экспорт доски", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Формат экспорта", exact: true })
    .selectOption("svg");
  await page
    .getByRole("button", { name: "Экспортировать", exact: true })
    .click();
  await expect(page.getByText(/Проверьте синтаксис/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Экспортировать", exact: true }),
  ).toBeEnabled();
});

test("presentation clips neighboring objects on wide screens and fit clears the contextual panel", async ({
  page,
}) => {
  await seed(page, [
    shape("frame-a", 400, 80, {
      kind: "frame",
      text: "Текущий",
      fontSize: 20,
      width: 260,
      height: 700,
      slideOrder: 0,
    }),
    shape("neighbor", 900, 350, { fill: "#ff0000", color: "#ff0000" }),
  ]);
  await page.getByTestId("board").focus();
  await page.keyboard.press("F5");
  await expect(page.getByLabel("Презентация", { exact: true })).toBeVisible();
  const color = await page.evaluate(() => {
    const e = window.__LIGHT_PEN_TEST__!.editor,
      c = e.camera,
      canvas = document.querySelector<HTMLCanvasElement>(".board-canvas")!,
      ratio = canvas.width / canvas.clientWidth;
    const x = Math.round((950 * c.zoom + c.x) * ratio),
      y = Math.round((400 * c.zoom + c.y) * ratio);
    return [...canvas.getContext("2d")!.getImageData(x, y, 1, 1).data];
  });
  expect(color.slice(0, 3)).toEqual([250, 250, 250]);
  await page.keyboard.press("Escape");
  await seed(page, [shape("large", 0, 0, { width: 1000, height: 600 })]);
  await page.getByRole("button", { name: "Перо (P)", exact: true }).click();
  await page
    .getByRole("button", { name: "Показать всю доску", exact: true })
    .click();
  const left = await page.evaluate(() => {
    const e = window.__LIGHT_PEN_TEST__!.editor;
    return -1.5 * e.camera.zoom + e.camera.x;
  });
  const panel = (await page
    .getByRole("complementary", { name: "Свойства инструмента", exact: true })
    .boundingBox())!;
  expect(left).toBeGreaterThan(panel.x + panel.width + 10);
});
test("marker size presets and slider use the same value and persist between launches", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Маркер (M)", exact: true }).click();
  await page.getByRole("button", { name: "Толщина 12", exact: true }).click();
  await expect(
    page.getByRole("slider", { name: "Размер маркера", exact: true }),
  ).toHaveValue("12");
  const a = await pointer(page, 500, 300),
    b = await pointer(page, 850, 360);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 20 });
  await page.mouse.up();
  expect((await scene(page)).elements[0].strokeWidth).toBe(12);
  await page.evaluate(() => window.__LIGHT_PEN_TEST__!.saver.flush());
  await page.reload();
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Маркер (M)", exact: true }).click();
  await expect(
    page.getByRole("slider", { name: "Размер маркера", exact: true }),
  ).toHaveValue("12");
});
