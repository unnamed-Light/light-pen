import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await page.evaluate(() => {
    const { editor, agent } = window.__LIGHT_PEN_TEST__!;
    editor.setDocument({
      ...editor.document,
      id: crypto.randomUUID(),
      revision: 0,
      elements: [],
    });
    editor.setTool("select");
    agent.enable({
      session: "agent-panel-session",
      write: true,
      files: false,
      network: false,
    });
  });
}

async function rpc(page: Page, name: string, args: Record<string, unknown>) {
  return page.evaluate(
    async ({ name, args }) => {
      const { editor, agent } = window.__LIGHT_PEN_TEST__!;
      return agent.rpc("tools/call", {
        name,
        arguments: {
          ...(name === "edit_batch"
            ? {
                session: agent.grant!.session,
                requestId: crypto.randomUUID(),
                documentId: editor.document.id,
                expectedRevision: editor.document.revision,
              }
            : {}),
          ...args,
        },
      }) as Promise<any>;
    },
    { name, args },
  );
}

async function success(
  page: Page,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await rpc(page, name, args);
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  return JSON.parse(result.content[0].text).result;
}

test("agent closes its own viewing dialogs and continues editing", async ({
  page,
}) => {
  await ready(page);
  const panels = [
    ["pen", "Перо под вашу руку"],
    ["history", "История версий"],
    ["planning", "Планирование"],
    ["help", "Удобно с первых линий"],
    ["export", "Экспорт доски"],
  ];
  for (const [action, title] of panels) {
    await success(page, "workspace_ui", { action });
    const dialog = page.getByRole("dialog", { name: title, exact: true });
    await expect(dialog).toBeVisible();
    await success(page, "workspace_ui", { action: "close" });
    await expect(dialog).toHaveCount(0);
    await success(page, "edit_batch", {
      operations: [{ op: "rename", title: `После ${action}` }],
    });
    expect(
      await page.evaluate(
        () => window.__LIGHT_PEN_TEST__!.editor.document.title,
      ),
    ).toBe(`После ${action}`);
  }
});

test("manual close and reopen revokes the agent's right to dismiss that dialog", async ({
  page,
}) => {
  await ready(page);
  await success(page, "workspace_ui", { action: "pen" });
  const dialog = page.getByRole("dialog", {
    name: "Перо под вашу руку",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Готово", exact: true }).click();
  await page
    .getByRole("button", { name: "Настройки пера", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  const denied = await rpc(page, "workspace_ui", { action: "close" });
  expect(denied.isError).toBe(true);
  await expect(dialog).toBeVisible();
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.agentPanel),
  ).toBeNull();
});

test("agent cannot dismiss a user's unsaved structured object draft", async ({
  page,
}) => {
  await ready(page);
  await success(page, "edit_batch", {
    operations: [
      {
        op: "create",
        elements: [
          {
            id: "user-task",
            kind: "task",
            x: 400,
            y: 200,
            width: 240,
            height: 180,
            text: "Исходная задача",
          },
        ],
      },
    ],
  });
  await page.evaluate(() => {
    const editor = window.__LIGHT_PEN_TEST__!.editor;
    editor.objectDraftMode = "content";
    editor.objectDraft = structuredClone(editor.elements[0]);
    editor.emit("ui");
  });
  const dialog = page.getByRole("dialog", {
    name: "Карточка задачи",
    exact: true,
  });
  const title = dialog.getByRole("textbox", {
    name: "Название объекта",
    exact: true,
  });
  await title.fill("Незавершённый ввод человека");
  const denied = await rpc(page, "workspace_ui", { action: "close" });
  expect(denied.isError).toBe(true);
  await expect(title).toHaveValue("Незавершённый ввод человека");
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements[0].text,
    ),
  ).toBe("Исходная задача");
});

test("active user input blocks closing even an agent-opened panel", async ({
  page,
}) => {
  await ready(page);
  await success(page, "workspace_ui", { action: "planning" });
  const dialog = page.getByRole("dialog", {
    name: "Планирование",
    exact: true,
  });
  const search = dialog.getByRole("textbox", {
    name: "Поиск задач",
    exact: true,
  });
  await search.fill("Пользователь вводит фильтр");
  const denied = await rpc(page, "workspace_ui", { action: "close" });
  expect(denied.isError).toBe(true);
  await expect(search).toHaveValue("Пользователь вводит фильтр");
  await expect(dialog).toBeVisible();
});
