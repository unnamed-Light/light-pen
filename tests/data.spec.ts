import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
const base = (id: string, kind: string, x = 450) => ({
  id,
  kind,
  x,
  y: 180,
  width: 420,
  height: 220,
  color: "#0f6cbd",
  fill: "#ffffff",
  strokeWidth: 2,
  opacity: 1,
  createdAt: Date.now(),
  fontSize: 18,
  text: kind === "table" ? "Расчёт" : "План выпуска",
});
async function seed(page: Page, elements: unknown[]) {
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await page.evaluate((elements) => {
    const e = window.__LIGHT_PEN_TEST__!.editor;
    e.setDocument({
      ...e.document,
      id: crypto.randomUUID(),
      schemaVersion: 4,
      revision: 0,
      elements: elements as typeof e.elements,
    });
    e.setCamera({ x: 0, y: 0, zoom: 1 });
    e.setTool("select");
  }, elements);
}
async function edit(page: Page, x = 560) {
  const box = (await page.getByTestId("board").boundingBox())!;
  await page.mouse.dblclick(box.x + x, box.y + 205);
}
async function doc(page: Page) {
  return page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.document);
}
test("typed table fields filter/sort with stable identities, export CSV and persist after reload", async ({
  page,
}, info) => {
  await seed(page, [
    {
      ...base("table", "table"),
      cells: [
        ["Название", "Цена"],
        ["Бета", "2"],
        ["Альфа", "10"],
        ["Гамма", "ошибка"],
      ],
      grid: {
        rows: ["head", "beta", "alpha", "gamma"],
        columns: [
          { id: "name", type: "text" },
          { id: "price", type: "text" },
        ],
      },
    },
  ]);
  await edit(page);
  await expect(
    page.getByRole("dialog", { name: "Таблица", exact: true }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Ячейка 2, 2", exact: true }).focus();
  await page
    .getByText("Поля, фильтры и обмен данными", { exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Тип выбранного поля", exact: true })
    .selectOption("number");
  await expect(
    page.getByRole("textbox", { name: "Ячейка 4, 2", exact: true }),
  ).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByRole("status").filter({ hasText: "Сумма" }),
  ).toContainText("Сумма: 12");
  await page
    .getByRole("textbox", { name: "Поиск записей таблицы", exact: true })
    .fill("альфа");
  await expect(page.locator(".editable-table tbody tr")).toHaveCount(2);
  await page
    .getByRole("textbox", { name: "Поиск записей таблицы", exact: true })
    .fill("");
  await page
    .getByRole("combobox", { name: "Поле сортировки таблицы", exact: true })
    .selectOption("price");
  await page
    .getByRole("combobox", { name: "Сортировка таблицы", exact: true })
    .selectOption("asc");
  await page
    .getByRole("button", { name: "Применить порядок", exact: true })
    .click();
  await page.screenshot({ path: info.outputPath("typed-data-fluent.png") });
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Экспорт CSV…", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("Расчёт.csv");
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  const saved = await doc(page);
  expect(saved.elements[0].grid!.columns[1].type).toBe("number");
  expect(saved.elements[0].grid!.rows).toEqual([
    "head",
    "beta",
    "alpha",
    "gamma",
  ]);
  await page.evaluate(() => window.__LIGHT_PEN_TEST__!.saver.flush());
  await page.reload();
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  expect((await doc(page)).elements).toEqual(saved.elements);
});
test("CSV import, row/column insertion and sorting keep record identities; cancel and undo are atomic", async ({
  page,
}) => {
  await seed(page, [
    {
      ...base("table", "table"),
      cells: [
        ["Имя", "Цена"],
        ["Бета", "2"],
        ["Альфа", "10"],
      ],
      grid: {
        rows: ["head", "beta", "alpha"],
        columns: [
          { id: "name", type: "text" },
          { id: "price", type: "number" },
        ],
      },
    },
  ]);
  await edit(page);
  await page.getByRole("textbox", { name: "Ячейка 2, 2", exact: true }).focus();
  await page.getByRole("button", { name: "+ Строка", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Ячейка 3, 1", exact: true })
    .fill("Новая");
  await page.getByRole("button", { name: "+ Столбец", exact: true }).click();
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  const first = await doc(page);
  expect(first.elements[0].grid!.rows[3]).toBe("alpha");
  expect(first.elements[0].grid!.columns[2].id).toBe("price");
  await page.getByTestId("board").focus();
  await page.keyboard.press("Control+z");
  expect((await doc(page)).elements[0].cells).toHaveLength(3);
  await edit(page);
  await page
    .getByText("Поля, фильтры и обмен данными", { exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Поле сортировки таблицы", exact: true })
    .selectOption("price");
  await page
    .getByRole("combobox", { name: "Сортировка таблицы", exact: true })
    .selectOption("desc");
  await page
    .getByRole("button", { name: "Применить порядок", exact: true })
    .click();
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  expect((await doc(page)).elements[0].grid!.rows).toEqual([
    "head",
    "alpha",
    "beta",
  ]);
  await page.getByTestId("board").focus();
  await page.keyboard.press("Control+z");
  await edit(page);
  await page
    .getByText("Поля, фильтры и обмен данными", { exact: true })
    .click();
  await page
    .getByLabel("Файл CSV", { exact: true })
    .setInputFiles({
      name: "данные.csv",
      mimeType: "text/csv",
      buffer: Buffer.from('\uFEFFНазвание;Цена\r\nОдин;"1,5"\r\nДва;4'),
    });
  await expect(
    page.getByRole("textbox", { name: "Ячейка 2, 2", exact: true }),
  ).toHaveValue("1,5");
  await page.getByRole("button", { name: "Отмена", exact: true }).click();
  expect((await doc(page)).elements[0].cells![1]).toEqual(["Бета", "2"]);
});
test("task planning fields, typed tags and dependencies save together and survive reload", async ({
  page,
}, info) => {
  await seed(page, [
    {
      ...base("task", "task"),
      task: {
        status: "todo",
        items: [{ id: "one", text: "Проверка", done: false }],
      },
    },
    {
      ...base("dependency", "task", 1000),
      text: "Подготовка",
      task: { status: "done", items: [] },
    },
  ]);
  await edit(page);
  await expect(
    page.getByRole("dialog", { name: "Карточка задачи", exact: true }),
  ).toBeVisible();
  await page.getByText("Описание и планирование", { exact: true }).click();
  await page
    .getByRole("textbox", { name: "Описание задачи", exact: true })
    .fill("Собрать и проверить выпуск");
  await page
    .getByRole("combobox", { name: "Приоритет задачи", exact: true })
    .selectOption("high");
  await page.getByLabel("Начало задачи", { exact: true }).fill("2026-11-03");
  await page.getByLabel("Срок задачи", { exact: true }).fill("2026-11-10");
  await page
    .getByRole("spinbutton", { name: "Оценка задачи", exact: true })
    .fill("2.5");
  await page
    .getByRole("textbox", { name: "Теги задачи", exact: true })
    .pressSequentially("Релиз, Проверки");
  await page
    .getByRole("listbox", { name: "Зависимости задачи", exact: true })
    .selectOption(["dependency"]);
  await page.screenshot({ path: info.outputPath("task-details-fluent.png") });
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  expect((await doc(page)).elements[0].task).toMatchObject({
    description: "Собрать и проверить выпуск",
    priority: "high",
    start: "2026-11-03",
    due: "2026-11-10",
    estimate: 2.5,
    tags: ["Релиз", "Проверки"],
    dependencies: ["dependency"],
  });
  await page.evaluate(() => window.__LIGHT_PEN_TEST__!.saver.flush());
  await page.reload();
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  expect((await doc(page)).elements[0].task!.tags).toEqual([
    "Релиз",
    "Проверки",
  ]);
});
