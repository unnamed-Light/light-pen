import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const example = JSON.parse(
  readFileSync("plugins/examples/ideas.lightpen-plugin", "utf8"),
);
async function call(
  page: Page,
  name: string,
  args: Record<string, unknown> = {},
) {
  return page.evaluate(
    async ({ name, args }) => {
      const { editor: e, agent: a } = window.__LIGHT_PEN_TEST__!;
      return a.rpc("tools/call", {
        name,
        arguments: {
          session: a.grant!.session,
          requestId: crypto.randomUUID(),
          documentId: e.document.id,
          expectedRevision: e.document.revision,
          pageId: e.activePageId,
          ...args,
        },
      });
    },
    { name, args },
  ) as Promise<any>;
}
// Read tools and workspace_ui do not accept write context.
async function ui(page: Page, action: string) {
  return page.evaluate(
    (action) =>
      window.__LIGHT_PEN_TEST__!.agent.rpc("tools/call", {
        name: "workspace_ui",
        arguments: { action },
      }),
    action,
  ) as Promise<any>;
}
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await page.evaluate(() => {
    const { editor: e, agent: a } = window.__LIGHT_PEN_TEST__!;
    e.setDocument({
      ...e.document,
      id: crypto.randomUUID(),
      schemaVersion: 3,
      pages: undefined,
      elements: [],
      revision: 0,
    });
    a.enable({
      session: "workspace-qa",
      write: true,
      files: false,
      network: false,
    });
  });
});
test("legacy boards accept new typed tables, fragments and plugins without partial writes", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Вставить объект", exact: true })
    .click();
  await page.getByRole("button", { name: "Таблица", exact: true }).click();
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements[0].kind,
    ),
  ).toBe("table");
  const fragment = JSON.parse(
    (
      await call(page, "fragments", {
        action: "read",
        ids: await page.evaluate(() => [
          window.__LIGHT_PEN_TEST__!.editor.elements[0].id,
        ]),
      })
    ).content[0].text,
  ).result;
  await page.evaluate(() => {
    const e = window.__LIGHT_PEN_TEST__!.editor;
    e.setDocument({
      ...e.document,
      schemaVersion: 3,
      pages: undefined,
      elements: [],
      revision: 0,
    });
  });
  const imported = await call(page, "fragments", {
    action: "import",
    fragment,
  });
  expect(imported.isError).not.toBe(true);
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.document.schemaVersion,
    ),
  ).toBe(5);
  await page.evaluate(async (bundle) => {
    const { editor: e, plugins: p } = window.__LIGHT_PEN_TEST__!;
    e.setDocument({
      ...e.document,
      schemaVersion: 3,
      pages: undefined,
      elements: [],
      revision: 0,
    });
    await p.install(bundle);
    await p.enable(bundle.manifest.id, {
      permissions: ["board:read", "board:write"],
    });
  }, example);
  const result = await call(page, "plugins", {
    action: "invoke",
    command: "lightpen.ideas/counter",
    args: { title: "Прежний файл", value: 2 },
  });
  expect(result.isError).not.toBe(true);
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements[0].widget?.fallback,
    ),
  ).toBe("Прежний файл\n2");
});
test("the agent opens and closes its own new viewing panels", async ({
  page,
}) => {
  const created = await call(page, "edit_batch", {
    operations: [
      {
        op: "create",
        elements: [
          {
            id: "note",
            kind: "sticky",
            x: 500,
            y: 200,
            width: 200,
            height: 120,
            text: "Данные",
          },
        ],
      },
    ],
  });
  expect(created.isError).not.toBe(true);
  await call(page, "selection", { action: "set", ids: ["note"] });
  for (const action of ["pages", "plugins", "fragments"]) {
    expect((await ui(page, action)).isError).not.toBe(true);
    const panel =
      action === "pages"
        ? page.getByRole("group", {
            name: "Страницы пространства",
            exact: true,
          })
        : page.getByRole("dialog");
    await expect(panel).toBeVisible();
    const closed = await ui(page, "close");
    expect(closed.isError, closed.content?.[0]?.text).not.toBe(true);
    await expect(panel).toHaveCount(0);
  }
  await ui(page, "pages");
  await page
    .getByRole("textbox", { name: "Поиск по пространству", exact: true })
    .fill("Ввод пользователя");
  const blocked = await ui(page, "close");
  expect(blocked.isError).toBe(true);
  await expect(
    page.getByRole("group", { name: "Страницы пространства", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
});
test("a read-only agent may run a read-only plugin command and cannot promote it to a board write", async ({
  page,
}) => {
  await page.evaluate(async (bundle) => {
    const { agent: a, plugins: p } = window.__LIGHT_PEN_TEST__!;
    await p.install(bundle);
    await p.enable(bundle.manifest.id, {
      permissions: ["board:read", "board:write"],
    });
    a.enable({
      session: "readonly-plugin",
      write: false,
      files: false,
      network: false,
    });
  }, example);
  const read = await call(page, "plugins", {
    action: "invoke",
    command: "lightpen.ideas/summary",
    args: {},
  });
  expect(read.isError, read.content?.[0]?.text).not.toBe(true);
  const write = await call(page, "plugins", {
    action: "invoke",
    command: "lightpen.ideas/counter",
    args: { title: "Нельзя", value: 4 },
  });
  expect(write.isError).toBe(true);
  expect(write.content[0].text).toContain("READ_ONLY");
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements.length,
    ),
  ).toBe(0);
});
