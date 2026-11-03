import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
async function setup(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await page.evaluate(() => {
    const e = window.__LIGHT_PEN_TEST__!.editor;
    const base = {
      kind: "task" as const,
      x: 440,
      y: 180,
      width: 320,
      height: 240,
      color: "#0f6cbd",
      fill: "#ffffff",
      strokeWidth: 2,
      opacity: 1,
      createdAt: Date.now(),
      fontSize: 18,
    };
    e.setDocument({
      ...e.document,
      id: crypto.randomUUID(),
      schemaVersion: 4,
      revision: 0,
      elements: [
        {
          ...base,
          id: "a",
          text: "Проверить выпуск",
          task: {
            status: "todo",
            start: "2026-11-03",
            due: "2026-11-05",
            priority: "high",
            tags: ["релиз"],
            items: [],
          },
        },
        {
          ...base,
          id: "b",
          x: 800,
          text: "Подготовить материалы",
          task: {
            status: "doing",
            due: "2026-11-04",
            items: [],
            dependencies: ["a"],
          },
        },
        {
          ...base,
          id: "old",
          x: 1200,
          text: "Архивная задача",
          task: { status: "done", archived: true, items: [] },
        },
      ],
    });
  });
  await open(page);
}
async function open(page: Page) {
  if (
    !(await page
      .getByRole("button", { name: "Планирование задач…", exact: true })
      .isVisible())
  )
    await page
      .getByRole("button", { name: "Вставить объект", exact: true })
      .click();
  await page
    .getByRole("button", { name: "Планирование задач…", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Планирование", exact: true }),
  ).toBeVisible();
}
test("kanban status moves and dragging update original tasks in one undo operation", async ({
  page,
}, info) => {
  await setup(page);
  await expect(page.locator(".planning-card")).toHaveCount(2);
  await page
    .getByRole("combobox", { name: "Статус a", exact: true })
    .selectOption("done");
  expect(
    await page.evaluate(
      () =>
        window.__LIGHT_PEN_TEST__!.editor.elements.find((e) => e.id === "a")!
          .task!.status,
    ),
  ).toBe("done");
  await expect(page.locator(".planning-warning")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("kanban-fluent.png") });
  await page
    .getByRole("button", { name: "Вернуться к доске", exact: true })
    .click();
  await page.getByTestId("board").focus();
  await page.keyboard.press("Control+z");
  expect(
    await page.evaluate(
      () =>
        window.__LIGHT_PEN_TEST__!.editor.elements.find((e) => e.id === "a")!
          .task!.status,
    ),
  ).toBe("todo");
  await open(page);
  await page
    .locator(".planning-card")
    .filter({ hasText: "Проверить выпуск" })
    .dragTo(
      page.getByRole("region", { name: "Колонка В работе", exact: true }),
    );
  expect(
    await page.evaluate(
      () =>
        window.__LIGHT_PEN_TEST__!.editor.elements.find((e) => e.id === "a")!
          .task!.status,
    ),
  ).toBe("doing");
});
test("calendar and timeline read the same dates, drill down, filter archives and return to editable source card", async ({
  page,
}, info) => {
  await setup(page);
  await page.getByRole("tab", { name: "Календарь", exact: true }).click();
  await page.getByLabel("Месяц календаря", { exact: true }).fill("2026-11");
  await expect(
    page.getByRole("button", { name: "Задачи на 2026-11-04", exact: true }),
  ).toContainText("2");
  await page
    .getByRole("button", { name: "Задачи на 2026-11-04", exact: true })
    .click();
  await expect(page.locator(".planning-card")).toHaveCount(2);
  await page.getByRole("tab", { name: "Таймлайн", exact: true }).click();
  await page.getByLabel("Начало таймлайна", { exact: true }).fill("2026-11-01");
  await expect(page.locator(".timeline-bar")).toHaveCount(2);
  await page.getByLabel("Начало таймлайна", { exact: true }).fill("9999-12-31");
  await page
    .getByLabel("Начало таймлайна", { exact: true })
    .fill("10000-01-01");
  await expect(
    page.getByLabel("Начало таймлайна", { exact: true }),
  ).toHaveValue("9999-12-31");
  await page.getByLabel("Начало таймлайна", { exact: true }).fill("2026-11-01");
  await page.screenshot({ path: info.outputPath("timeline-fluent.png") });
  await page.getByRole("tab", { name: "Обзор", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "Задачи по статусам", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".planning-summary")).toContainText("2 задач");
  await page.getByRole("checkbox", { name: "Архив", exact: true }).check();
  await expect(page.locator(".planning-summary")).toContainText("3 задач");
  await page.getByRole("tab", { name: "Канбан", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Поиск задач", exact: true })
    .fill("Проверить");
  await expect(page.locator(".planning-card")).toHaveCount(1);
  await page
    .getByRole("button", { name: "Проверить выпуск", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Карточка задачи", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Название объекта", exact: true }),
  ).toHaveValue("Проверить выпуск");
});
test("read-only planning keeps navigation available and disables editing, including drag and status changes", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const e = window.__LIGHT_PEN_TEST__!.editor;
    e.readOnly = true;
    e.emit("ui");
  });
  await expect(
    page.getByRole("combobox", { name: "Статус a", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".planning-card").first()).toHaveAttribute(
    "draggable",
    "false",
  );
  await page
    .getByRole("button", { name: "Проверить выпуск", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    await page.evaluate(() => [...window.__LIGHT_PEN_TEST__!.editor.selected]),
  ).toContain("a");
});
