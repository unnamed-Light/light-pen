import { test, expect } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
});
test("pages stay in one selector: create, rename, duplicate, delete, undo and search another page", async ({
  page,
}, info) => {
  await page.evaluate(() => {
    const e = window.__LIGHT_PEN_TEST__!.editor;
    e.commitWorkspace([], e.pages, "Clear");
    e.renamePage("main", "Обзор");
    e.history.clear();
  });
  await page
    .getByRole("button", { name: "Страницы: Обзор", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Новая страница", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Страницы: Новая страница", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Действия страницы Новая страница",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: "Переименовать…", exact: true })
    .click();
  const naming = page.getByRole("dialog", {
    name: "Название страницы",
    exact: true,
  });
  await naming
    .getByRole("textbox", { name: "Название страницы", exact: true })
    .fill("Проработка");
  await naming.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page.evaluate(() => {
    const e = window.__LIGHT_PEN_TEST__!.editor;
    e.addStructured("task");
    e.saveObjectDraft({ ...e.objectDraft!, text: "Проверить необычную мысль" });
    e.switchPage("main");
  });
  await page
    .getByRole("button", { name: "Страницы: Обзор", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Поиск по пространству", exact: true })
    .fill("необычную");
  await page
    .getByRole("button", {
      name: "Проверить необычную мысль Проработка",
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("button", { name: "Страницы: Проработка", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.selection[0].text,
    ),
  ).toBe("Проверить необычную мысль");
  await page
    .getByRole("button", { name: "Страницы: Проработка", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Поиск по пространству", exact: true })
    .fill("");
  await page
    .getByRole("button", { name: "Действия страницы Проработка", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Дублировать", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Страницы: Проработка — копия", exact: true })
    .click();
  await page
    .getByRole("button", {
      name: "Действия страницы Проработка — копия",
      exact: true,
    })
    .click();
  await page.getByRole("menuitem", { name: "Удалить…", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Удалить страницу?", exact: true })
    .getByRole("button", { name: "Удалить", exact: true })
    .click();
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.pages.length),
  ).toBe(2);
  await page.getByRole("button", { name: "Отменить", exact: true }).click();
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.pages.length),
  ).toBe(3);
  await page
    .getByRole("button", { name: "Страницы: Проработка — копия", exact: true })
    .click();
  await page.screenshot({ path: info.outputPath("fluent-pages-selector.png") });
});
test("a large page list remains searchable and the header fits the minimum desktop window", async ({
  page,
}, info) => {
  await page.evaluate(() => {
    const e = window.__LIGHT_PEN_TEST__!.editor;
    const pages = Array.from({ length: 1000 }, (_, i) => ({
      id: i === 0 ? "main" : "page-" + i,
      title: "Раздел " + i,
    }));
    e.commitWorkspace([], pages, "Many pages");
  });
  await page
    .getByRole("button", { name: "Страницы: Раздел 0", exact: true })
    .click();
  expect(await page.locator(".pages-row").count()).toBe(60);
  await page
    .getByRole("textbox", { name: "Поиск по пространству", exact: true })
    .fill("Раздел 999");
  await page.getByRole("button", { name: "Раздел 999", exact: true }).click();
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.activePageId),
  ).toBe("page-999");
  await page.setViewportSize({ width: 800, height: 560 });
  await expect(
    page.getByRole("button", { name: "Страницы: Раздел 999", exact: true }),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({ path: info.outputPath("quiet-header-800.png") });
});
