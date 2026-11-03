import { test, expect } from "@playwright/test";
import { createCollaborationServer } from "../server/server";
import type { Browser, Page } from "@playwright/test";
let server: ReturnType<typeof createCollaborationServer>, service: string;
test.beforeAll(async () => {
  server = createCollaborationServer({ database: ":memory:" });
  service = await server.listen();
});
test.afterAll(async () => {
  await server.close();
});
async function app(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  return { page, context };
}
async function open(page: Page) {
  await page
    .getByRole("button", { name: "Совместная работа", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Совместная работа", exact: true }),
  ).toBeVisible();
}
test("guests collaborate across isolated browser profiles; read-only invitation and revocation preserve data", async ({
  browser,
}) => {
  test.setTimeout(120000);
  const a = await app(browser),
    b = await app(browser),
    viewer = await app(browser);
  try {
    await open(a.page);
    await a.page
      .getByRole("textbox", { name: "Адрес сервиса", exact: true })
      .fill(service);
    await a.page
      .getByRole("button", {
        name: "Создать общую доску без аккаунта",
        exact: true,
      })
      .click();
    await expect(
      a.page.getByRole("dialog", { name: "Совместная работа", exact: true }),
    ).toBeHidden();
    await open(a.page);
    await a.page
      .getByRole("button", { name: "Создать приглашение", exact: true })
      .click();
    const link = await a.page
      .getByRole("textbox", { name: "Готовое приглашение", exact: true })
      .inputValue();
    expect(link).toContain("/join/");
    await a.page.getByRole("button", { name: "Закрыть", exact: true }).click();
    await open(b.page);
    await b.page
      .getByRole("textbox", { name: "Приглашение Light Pen", exact: true })
      .fill(link);
    await b.page
      .getByRole("button", { name: "Подключиться", exact: true })
      .click();
    await expect(
      b.page.getByRole("dialog", { name: "Совместная работа", exact: true }),
    ).toBeHidden();
    const title = a.page.getByRole("textbox", {
      name: "Название доски",
      exact: true,
    });
    await title.fill("Совместный проект");
    await title.press("Enter");
    await expect(
      b.page.getByRole("textbox", { name: "Название доски", exact: true }),
    ).toHaveValue("Совместный проект");
    await b.page
      .getByRole("button", { name: "Прямоугольник (R)", exact: true })
      .click();
    const board = b.page.getByTestId("board"),
      box = (await board.boundingBox())!;
    await b.page.mouse.move(box.x + 700, box.y + 220);
    await b.page.mouse.down();
    await b.page.mouse.move(box.x + 900, box.y + 350, { steps: 12 });
    await b.page.mouse.up();
    const count = await b.page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements.length,
    );
    await expect
      .poll(() =>
        a.page.evaluate(
          () => window.__LIGHT_PEN_TEST__!.editor.elements.length,
        ),
      )
      .toBe(count);
    await open(a.page);
    await a.page.getByLabel("Доступ по приглашению").selectOption("viewer");
    await a.page
      .getByRole("button", { name: "Создать приглашение", exact: true })
      .click();
    const viewLink = await a.page
      .getByRole("textbox", { name: "Готовое приглашение", exact: true })
      .inputValue();
    await a.page.getByRole("button", { name: "Закрыть", exact: true }).click();
    await open(viewer.page);
    await viewer.page
      .getByRole("textbox", { name: "Приглашение Light Pen", exact: true })
      .fill(viewLink);
    await viewer.page
      .getByRole("button", { name: "Подключиться", exact: true })
      .click();
    await expect(
      viewer.page.getByRole("dialog", {
        name: "Совместная работа",
        exact: true,
      }),
    ).toBeHidden();
    await expect
      .poll(() =>
        viewer.page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.readOnly),
      )
      .toBe(true);
    await viewer.page.evaluate(() =>
      window.__LIGHT_PEN_TEST__!.editor.commit([], "Forbidden"),
    );
    expect(
      await viewer.page.evaluate(
        () => window.__LIGHT_PEN_TEST__!.editor.elements.length,
      ),
    ).toBe(count);
    await open(a.page);
    await a.page.getByText("Выданный доступ", { exact: true }).click();
    const rows = a.page.locator(".shared-access-row");
    await rows
      .filter({ hasText: "Просмотр" })
      .getByRole("button", { name: "Отозвать", exact: true })
      .click();
    await expect(
      viewer.page.getByRole("button", {
        name: "Совместная работа",
        exact: true,
      }),
    ).toContainText("Доступ отозван");
    expect(
      await viewer.page.evaluate(
        () => window.__LIGHT_PEN_TEST__!.editor.elements.length,
      ),
    ).toBe(count);
  } finally {
    await a.context.close();
    await b.context.close();
    await viewer.context.close();
  }
});
test("account registration, personal room list and account membership work from the dialog", async ({
  browser,
}) => {
  const a = await app(browser);
  try {
    await open(a.page);
    await a.page.getByRole("button", { name: "Аккаунт", exact: true }).click();
    await a.page
      .getByRole("textbox", { name: "Адрес сервиса", exact: true })
      .fill(service);
    await a.page.getByLabel("Логин", { exact: true }).fill("browser-user");
    await a.page
      .getByLabel("Пароль", { exact: true })
      .fill("browser-testing-password");
    await a.page
      .getByLabel("Имя для участников", { exact: true })
      .fill("Участник");
    await a.page
      .getByRole("button", { name: "Создать аккаунт", exact: true })
      .click();
    await expect(
      a.page.getByText("browser-user", { exact: true }),
    ).toBeVisible();
    await a.page.getByRole("button", { name: "Доска", exact: true }).click();
    await a.page
      .getByRole("button", {
        name: "Создать общую доску в аккаунте",
        exact: true,
      })
      .click();
    await expect(
      a.page.getByRole("dialog", { name: "Совместная работа", exact: true }),
    ).toBeHidden();
    await open(a.page);
    await a.page.getByRole("button", { name: "Участник", exact: true }).click();
    await a.page
      .getByRole("button", { name: "Обновить мои доски", exact: true })
      .click();
    await expect(a.page.locator(".shared-room-list button")).toHaveCount(1);
  } finally {
    await a.context.close();
  }
});
test("remembered guest access reopens the room while detached local edits retain an independent draft", async ({
  browser,
}) => {
  test.setTimeout(90000);
  const a = await app(browser);
  try {
    await open(a.page);
    await a.page
      .getByRole("textbox", { name: "Адрес сервиса", exact: true })
      .fill(service);
    await a.page
      .getByRole("button", {
        name: "Создать общую доску без аккаунта",
        exact: true,
      })
      .click();
    await expect(
      a.page.getByRole("dialog", { name: "Совместная работа", exact: true }),
    ).toBeHidden();
    const shared = await a.page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.document.id,
    );
    await open(a.page);
    await expect(
      a.page.getByText("Сохранить доступ владельца", { exact: true }),
    ).toBeVisible();
    await a.page
      .getByRole("button", {
        name: "Отключиться и оставить локальную копию",
        exact: true,
      })
      .click();
    await a.page.getByRole("button", { name: "Закрыть", exact: true }).click();
    const detached = await a.page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.document.id,
    );
    expect(detached).not.toBe(shared);
    const title = a.page.getByRole("textbox", {
      name: "Название доски",
      exact: true,
    });
    await title.fill("Независимые локальные правки");
    await title.press("Enter");
    await a.page.evaluate(() => window.__LIGHT_PEN_TEST__!.saver.flush());
    await open(a.page);
    await a.page.locator(".saved-shared-rooms button").first().click();
    await expect(
      a.page.getByRole("dialog", { name: "Совместная работа", exact: true }),
    ).toBeHidden();
    expect(
      await a.page.evaluate(
        () => window.__LIGHT_PEN_TEST__!.editor.document.id,
      ),
    ).toBe(shared);
    const local = await a.page.evaluate(
      (id) =>
        JSON.parse(
          localStorage.getItem("lightpen.preview.drafts") ?? "[]",
        ).find((entry: any) => entry.document?.id === id)?.document.title,
      detached,
    );
    expect(local).toBe("Независимые локальные правки");
    await open(a.page);
    await a.page
      .getByRole("button", {
        name: "Отключиться и оставить локальную копию",
        exact: true,
      })
      .click();
    await a.page
      .getByRole("button", { name: /^Забыть сохранённый доступ / })
      .click();
    await a.page
      .getByRole("button", { name: "Забыть на этом ПК", exact: true })
      .click();
    await expect(a.page.locator(".saved-shared-rooms")).toHaveCount(0);
  } finally {
    await a.context.close();
  }
});
test("reopening an account room restores account context and never presents its session token as an owner invitation", async ({
  browser,
}) => {
  const a = await app(browser);
  try {
    await open(a.page);
    await a.page.getByRole("button", { name: "Аккаунт", exact: true }).click();
    await a.page
      .getByRole("textbox", { name: "Адрес сервиса", exact: true })
      .fill(service);
    await a.page.getByLabel("Логин", { exact: true }).fill("remembered-user");
    await a.page
      .getByLabel("Пароль", { exact: true })
      .fill("remembered-user-password");
    await a.page
      .getByLabel("Имя для участников", { exact: true })
      .fill("Сохранённый участник");
    await a.page
      .getByRole("button", { name: "Создать аккаунт", exact: true })
      .click();
    await expect(
      a.page.getByText("remembered-user", { exact: true }),
    ).toBeVisible();
    await a.page.getByRole("button", { name: "Доска", exact: true }).click();
    await a.page
      .getByRole("button", {
        name: "Создать общую доску в аккаунте",
        exact: true,
      })
      .click();
    await expect(
      a.page.getByRole("dialog", { name: "Совместная работа", exact: true }),
    ).toBeHidden();
    await open(a.page);
    await expect(
      a.page.getByText("Сохранить доступ владельца", { exact: true }),
    ).toHaveCount(0);
    await a.page
      .getByRole("button", {
        name: "Отключиться и оставить локальную копию",
        exact: true,
      })
      .click();
    await a.page.locator(".saved-shared-rooms button").first().click();
    await expect(
      a.page.getByRole("dialog", { name: "Совместная работа", exact: true }),
    ).toBeHidden();
    await open(a.page);
    await expect(
      a.page.getByText("Сохранить доступ владельца", { exact: true }),
    ).toHaveCount(0);
    await a.page
      .getByRole("button", { name: "Сохранённый участник", exact: true })
      .click();
    await expect(
      a.page.getByRole("button", { name: "Выйти из аккаунта", exact: true }),
    ).toBeVisible();
  } finally {
    await a.context.close();
  }
});
