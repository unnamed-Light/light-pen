import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { createCollaborationServer } from "../server/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
async function ready(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await page.evaluate(() => {
    const { editor: e, agent } = window.__LIGHT_PEN_TEST__!;
    e.setDocument({
      ...e.document,
      id: crypto.randomUUID(),
      revision: 0,
      elements: [],
    });
    e.setTool("select");
    agent.enable({
      session: "browser-agent-session",
      write: true,
      files: false,
      network: false,
    });
  });
}
async function call(
  page: Page,
  name: string,
  args: Record<string, unknown> = {},
) {
  return page.evaluate(
    async ({ name, args }) => {
      const a = window.__LIGHT_PEN_TEST__!.agent,
        e = a.editor;
      const result = (await a.rpc("tools/call", {
        name,
        arguments: {
          ...([
            "edit_batch",
            "history",
            "selection",
            "settings",
            "document",
            "versions",
            "templates",
            "image_import",
            "export",
            "collaboration",
          ].includes(name)
            ? {
                session: a.grant!.session,
                requestId: crypto.randomUUID(),
                documentId: e.document.id,
                expectedRevision: e.document.revision,
              }
            : {}),
          ...args,
        },
      })) as any;
      if (result.isError) throw Error(result.content[0].text);
      if (name === "board_preview") return result;
      return JSON.parse(result.content[0].text).result;
    },
    { name, args },
  );
}
const shape = (id: string, kind = "sticky", x = 400, y = 200) => ({
  id,
  kind,
  x,
  y,
  width: 220,
  height: 140,
  text: kind === "math" ? "\\frac{a}{b}" : "Заметка",
});
test("AI access has an explicit compact Fluent control, read-only mode and immediate revocation", async ({
  page,
}, info) => {
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Меню файла", exact: true }).click();
  await page.getByRole("menuitem", { name: "Доступ ИИ…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Доступ ИИ", exact: true });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("checkbox", { name: "Разрешить редактирование", exact: true })
    .uncheck();
  await dialog
    .getByRole("button", { name: "Включить доступ", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("Доступ включён");
  await expect(
    dialog.getByRole("textbox", { name: "Конфигурация подключения ИИ" }),
  ).toContainText("настольную");
  const denied = await page.evaluate(async () => {
    const a = window.__LIGHT_PEN_TEST__!.agent;
    return a.rpc("tools/call", {
      name: "edit_batch",
      arguments: {
        session: a.grant!.session,
        requestId: "denied",
        documentId: a.editor.document.id,
        expectedRevision: a.editor.document.revision,
        operations: [],
      },
    });
  });
  expect((denied as any).isError).toBe(true);
  expect((denied as any).content[0].text).toContain("READ_ONLY");
  await page.screenshot({ path: info.outputPath("ai-access-fluent-dark.png") });
  await page.setViewportSize({ width: 800, height: 560 });
  await expect(
    dialog.getByRole("button", { name: "Отключить доступ", exact: true }),
  ).toBeInViewport();
  await page.screenshot({ path: info.outputPath("ai-access-compact.png") });
  await dialog
    .getByRole("button", { name: "Отключить доступ", exact: true })
    .click();
  await expect(dialog.getByRole("status")).toContainText("Доступ выключен");
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Доступ ИИ включён" }),
  ).toHaveCount(0);
});
test("agent builds a real mixed board, sees PNG and LaTeX, rolls back invalid assets and persists one undo step", async ({
  page,
}) => {
  await ready(page);
  const elements = [
    shape("sticky"),
    shape("text", "text", 650, 200),
    shape("formula", "math", 650, 400),
    { ...shape("frame", "frame", 350, 150), width: 650, height: 500 },
    {
      ...shape("arrow", "arrow"),
      endX: 650,
      endY: 270,
      startBinding: { elementId: "sticky", side: "right" },
      endBinding: { elementId: "text", side: "left" },
    },
    {
      ...shape("table", "table", 400, 410),
      cells: [
        ["Цена", "Количество"],
        ["2", "3"],
      ],
      grid: {
        rows: ["h", "r1"],
        columns: [
          { id: "price", type: "number" },
          { id: "qty", type: "number" },
        ],
      },
    },
    {
      ...shape("task", "task", 900, 200),
      task: {
        status: "doing",
        items: [{ id: "i1", text: "Проверка", done: false }],
        start: "2026-11-03",
        due: "2026-11-07",
      },
    },
  ];
  await call(page, "edit_batch", {
    label: "План от ИИ",
    operations: [
      { op: "create", elements },
      { op: "rename", title: "Доска от ИИ" },
    ],
  });
  await expect(
    page.getByRole("textbox", { name: "Название доски" }),
  ).toHaveValue("Доска от ИИ");
  const preview = await call(page, "board_preview", {
    scope: "frame",
    frameId: "frame",
    maxSize: 800,
  });
  expect(preview.content[0].type).toBe("image");
  expect(preview.content[0].data.length).toBeGreaterThan(5000);
  const before = await page.evaluate(() =>
    JSON.stringify(window.__LIGHT_PEN_TEST__!.editor.document),
  );
  await expect(
    call(page, "edit_batch", {
      operations: [
        { op: "update", id: "sticky", patch: { text: "должно откатиться" } },
        {
          op: "create",
          elements: [{ ...shape("invalid", "math"), text: "\\doesnotexist{" }],
        },
      ],
    }),
  ).rejects.toThrow();
  expect(
    await page.evaluate(() =>
      JSON.stringify(window.__LIGHT_PEN_TEST__!.editor.document),
    ),
  ).toBe(before);
  await call(page, "history", { action: "undo" });
  expect((await call(page, "board_read")).objects).toBe(0);
  await call(page, "history", { action: "redo" });
  expect((await call(page, "board_read")).objects).toBe(7);
  await call(page, "document", { action: "save" });
  await page.reload();
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await expect(
    page.getByRole("textbox", { name: "Название доски" }),
  ).toHaveValue("Доска от ИИ");
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.agent.grant),
  ).toBeNull();
});
test("agent uses the actual template library, checkpoints, selection and structured data", async ({
  page,
}) => {
  await ready(page);
  await call(page, "edit_batch", {
    operations: [
      {
        op: "create",
        elements: [shape("a"), shape("b", "rectangle", 700, 200)],
      },
    ],
  });
  await call(page, "selection", { action: "set", ids: ["a", "b"] });
  const saved = await call(page, "templates", {
    action: "save",
    title: "Шаблон ИИ",
  });
  const templatePage = await call(page, "templates", {
    action: "read",
    id: saved.id,
    limit: 1,
  });
  expect(templatePage.total).toBe(2);
  expect(templatePage.elements).toHaveLength(1);
  expect(templatePage.next).toBe(1);
  expect(
    (await call(page, "templates", { action: "list" })).some(
      (x: any) => x.id === saved.id,
    ),
  ).toBe(true);
  await call(page, "templates", { action: "insert", id: saved.id });
  expect((await call(page, "board_read")).objects).toBe(4);
  await call(page, "versions", { action: "create" });
  const versions = await call(page, "versions", { action: "list" });
  const snapshotPage = await call(page, "versions", {
    action: "read",
    version: versions[0].id,
    limit: 1,
  });
  expect(snapshotPage.total).toBe(4);
  expect(snapshotPage.elements).toHaveLength(1);
  await call(page, "edit_batch", {
    operations: [{ op: "update", id: "a", patch: { text: "Изменено" } }],
  });
  await call(page, "versions", { action: "restore", version: versions[0].id });
  const read = await call(page, "objects_read", { ids: ["a"] });
  expect(read.elements[0].text).toBe("Заметка");
  await call(page, "templates", { action: "remove", id: saved.id });
});
test("agent settings update Fluent controls and existing task views without extra persistent panels", async ({
  page,
}) => {
  await ready(page);
  await call(page, "edit_batch", {
    operations: [
      {
        op: "create",
        elements: [shape("paint-original", "rectangle", 100, 100)],
      },
    ],
  });
  await call(page, "selection", { action: "set", ids: ["paint-original"] });
  await call(page, "settings", {
    tool: "pen",
    style: { fontSize: 72, color: "#7f52c5", strokeWidth: 6 },
    pen: { smoothing: 75, stabilization: 20, minWidth: 50, pressure: 125 },
    grid: false,
    snap: false,
    minimap: true,
    dark: false,
    favoriteColors: ["#7f52c5"],
    recentColors: ["#0f6cbd"],
  });
  expect(
    (await call(page, "objects_read", { ids: ["paint-original"] })).elements[0]
      .color,
  ).toBe("#0f6cbd");
  expect((await call(page, "board_read")).preferences.favoriteColors).toEqual([
    "#7f52c5",
  ]);
  await expect(
    page.getByRole("button", { name: "Свернуть миникарту", exact: true }),
  ).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await call(page, "edit_batch", {
    operations: [
      {
        op: "create",
        elements: [
          {
            ...shape("task", "task"),
            task: {
              status: "todo",
              items: [],
              start: "2026-11-03",
              due: "2026-11-07",
              priority: "high",
              tags: ["ИИ"],
            },
          },
        ],
      },
    ],
  });
  expect((await call(page, "tasks_read", { tag: "ИИ" })).tasks).toHaveLength(1);
  await call(page, "workspace_ui", { action: "planning" });
  await expect(
    page.getByRole("dialog", { name: "Планирование", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Таймлайн", exact: true }).click();
  await expect(
    page.getByText("Заметка", { exact: true }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Вернуться к доске", exact: true })
    .click();
  await call(page, "workspace_ui", { action: "pen" });
  await expect(
    page.getByRole("dialog", { name: "Перо под вашу руку", exact: true }),
  ).toBeVisible();
});
test("agent drives presentation, navigation and temporary annotations without changing saved objects", async ({
  page,
}) => {
  await ready(page);
  await call(page, "edit_batch", {
    operations: [
      {
        op: "create",
        elements: [
          { ...shape("f1", "frame", 0, 0), width: 600, height: 400 },
          { ...shape("f2", "frame", 700, 0), width: 600, height: 400 },
        ],
      },
    ],
  });
  const revision = (await call(page, "board_read")).context.revision;
  await call(page, "presentation", { action: "start" });
  await expect(page.getByLabel("Презентация", { exact: true })).toBeVisible();
  await call(page, "presentation", { action: "show", frameId: "f2" });
  await call(page, "presentation", { action: "mode", mode: "ink" });
  await call(page, "presentation", {
    action: "annotate",
    points: [
      { x: 750, y: 100 },
      { x: 950, y: 200 },
    ],
  });
  await expect(page.locator(".presentation-input polyline")).toHaveCount(1);
  await call(page, "presentation", { action: "clear" });
  await expect(page.locator(".presentation-input polyline")).toHaveCount(0);
  await call(page, "presentation", { action: "stop" });
  await expect(page.getByLabel("Презентация", { exact: true })).toHaveCount(0);
  expect((await call(page, "board_read")).context.revision).toBe(revision);
});
test("agent collaborates through real server adapters, creates/revokes invites and detaches safely", async ({
  page,
}) => {
  const folder = await mkdtemp(join(tmpdir(), "lightpen-agent-ui-")),
    server = createCollaborationServer({ database: join(folder, "db.sqlite") });
  try {
    const url = await server.listen();
    await ready(page);
    await page.evaluate(() => {
      const a = window.__LIGHT_PEN_TEST__!.agent;
      a.enable({ ...a.grant!, network: true });
    });
    await call(page, "edit_batch", {
      operations: [{ op: "create", elements: [shape("a")] }],
    });
    const created = await call(page, "collaboration", {
      action: "create",
      server: url,
    });
    expect(created.role).toBe("owner");
    await expect(
      page.getByRole("button", { name: "Совместная работа", exact: true }),
    ).toContainText("Общая доска");
    await call(page, "edit_batch", {
      operations: [
        { op: "update", id: "a", patch: { text: "Общая правка ИИ" } },
      ],
    });
    const invite = await call(page, "collaboration", {
      action: "invite",
      role: "viewer",
      hours: 1,
    });
    expect(invite.invitation).toContain("/join/");
    const access = await call(page, "collaboration", { action: "list_access" });
    expect(JSON.stringify(access)).not.toContain("token");
    await call(page, "collaboration", { action: "revoke", id: invite.id });
    const sharedId = (await call(page, "board_read")).context.documentId;
    await call(page, "collaboration", { action: "disconnect" });
    expect((await call(page, "board_read")).context.documentId).not.toBe(
      sharedId,
    );
    expect(
      (await call(page, "objects_read", { ids: ["a"] })).elements[0].text,
    ).toBe("Общая правка ИИ");
  } finally {
    await server.close();
    if (
      dirname(folder) !== tmpdir() ||
      !basename(folder).startsWith("lightpen-agent-ui-")
    )
      throw Error("Unsafe cleanup");
    await rm(folder, { recursive: true, force: true });
  }
});
