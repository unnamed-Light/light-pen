import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

function shape(
  id: string,
  x = 440,
  y = 200,
  extra: Record<string, unknown> = {},
) {
  return {
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
    fontSize: 24,
    createdAt: Date.now(),
    pageId: "main",
    ...extra,
  };
}
async function seed(page: Page, elements: unknown[]) {
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await page.evaluate((elements) => {
    const editor = window.__LIGHT_PEN_TEST__!.editor;
    const image = document.createElement("canvas");
    image.width = image.height = 4;
    image.getContext("2d")!.fillRect(0, 0, 4, 4);
    for (const e of elements as Record<string, unknown>[])
      if (e.kind === "image" && !e.dataUrl)
        e.dataUrl = image.toDataURL("image/png");
    editor.setDocument({
      ...editor.document,
      id: crypto.randomUUID(),
      revision: 0,
      title: "Проверка переноса",
      schemaVersion: 5,
      pages: [
        { id: "main", title: "Первая страница" },
        { id: "other", title: "Вторая страница" },
      ],
      elements: elements as typeof editor.elements,
    });
    editor.setTool("select");
    editor.setCamera({ x: 0, y: 0, zoom: 1 });
    editor.snap = false;
    window.__LIGHT_PEN_TEST__!.saver.reset(null);
    window.__LIGHT_PEN_TEST__!.saver.schedule(editor.document);
  }, elements);
}
async function point(page: Page, x: number, y: number) {
  const box = (await page.getByTestId("board").boundingBox())!;
  return { x: box.x + x, y: box.y + y };
}
async function service(
  page: Page,
  name: string,
  args: Record<string, unknown> = {},
) {
  return page.evaluate(
    async ({ name, args }) => {
      const handler = window.__LIGHT_PEN_TEST__!.editor.services.get(name);
      if (!handler) throw Error(`Service is unavailable: ${name}`);
      return handler(args) as Promise<any>;
    },
    { name, args },
  );
}
async function greenPixels(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(".board-overlay")!;
    const rgba = canvas
      .getContext("2d")!
      .getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < rgba.length; i += 4)
      if (
        rgba[i + 1] > rgba[i] + 40 &&
        rgba[i + 1] > rgba[i + 2] + 40 &&
        rgba[i + 3] > 150
      )
        count++;
    return count;
  });
}

test("Ctrl links navigate pages without a pen mark; keyboard fallback opens once", async ({
  page,
}) => {
  await seed(page, [
    shape("source", 440, 200, {
      link: { path: "", pageId: "other", elementId: "target" },
    }),
    shape("target", 440, 200, {
      pageId: "other",
      link: { path: "", pageId: "main", elementId: "source" },
    }),
  ]);
  const source = await point(page, 500, 250);
  await page.mouse.click(source.x, source.y);
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.activePageId),
  ).toBe("main");
  await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.setTool("pen"));
  const documentBefore = await page.evaluate(() =>
    JSON.stringify(window.__LIGHT_PEN_TEST__!.editor.document),
  );
  await page.keyboard.down("Control");
  await page.mouse.move(source.x, source.y);
  await expect(page.getByTestId("board")).toHaveCSS("cursor", "pointer");
  await page.mouse.click(source.x, source.y);
  await page.keyboard.up("Control");
  await expect
    .poll(() =>
      page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.activePageId),
    )
    .toBe("other");
  expect(
    await page.evaluate(() =>
      JSON.stringify(window.__LIGHT_PEN_TEST__!.editor.document),
    ),
  ).toBe(documentBefore);
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.gesture),
  ).toBeNull();
  await page.evaluate(() => {
    const editor = window.__LIGHT_PEN_TEST__!.editor;
    editor.switchPage("main");
    editor.setTool("select");
    editor.selected = new Set(["source"]);
    editor.emit("ui");
  });
  await page.getByTestId("board").focus();
  await page.evaluate(() => {
    const board = document.querySelector<HTMLCanvasElement>(
      '[data-testid="board"]',
    )!;
    board.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    board.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Enter",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect
    .poll(() =>
      page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.activePageId),
    )
    .toBe("other");
  await page.waitForTimeout(50);
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.activePageId),
  ).toBe("other");
});

test("link editor chooses a page and a page-only link remains editable", async ({
  page,
}) => {
  await seed(page, [
    shape("source"),
    shape("target", 440, 200, { pageId: "other", text: "Назначение" }),
  ]);
  await page.evaluate(() => {
    const editor = window.__LIGHT_PEN_TEST__!.editor;
    editor.objectDraftMode = "link";
    editor.objectDraft = { ...editor.elements[0], link: { path: "" } };
    editor.emit("ui");
  });
  const dialog = page.getByRole("dialog", {
    name: "Локальная ссылка",
    exact: true,
  });
  await dialog
    .getByLabel("Страница назначения", { exact: true })
    .selectOption("other");
  await expect(
    dialog
      .getByLabel("Объект назначения", { exact: true })
      .getByRole("option", { name: "Назначение", exact: true }),
  ).toHaveCount(1);
  await dialog.getByRole("button", { name: "Применить", exact: true }).click();
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements[0].link,
    ),
  ).toEqual({ path: "", pageId: "other" });
});

test("personal frame marks persist, filter the existing list and never enter PNG or document history", async ({
  page,
}, info) => {
  await seed(page, [
    shape("frame-a", 440, 200, {
      kind: "frame",
      width: 300,
      height: 200,
      text: "Глава 1",
    }),
    shape("frame-b", 800, 200, {
      kind: "frame",
      width: 300,
      height: 200,
      text: "Глава 2",
    }),
  ]);
  const before = await page.evaluate(() =>
    JSON.stringify(window.__LIGHT_PEN_TEST__!.editor.document),
  );
  const frame = await point(page, 445, 205);
  await page.mouse.click(frame.x, frame.y, { button: "right" });
  await page
    .getByRole("menuitem", { name: "Отметить просмотренным", exact: true })
    .click();
  expect(
    await page.evaluate(() =>
      JSON.stringify(window.__LIGHT_PEN_TEST__!.editor.document),
    ),
  ).toBe(before);
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.history.canUndo,
    ),
  ).toBe(false);
  await page.evaluate(() => {
    const editor = window.__LIGHT_PEN_TEST__!.editor;
    editor.selected.clear();
    editor.emit("overlay");
  });
  await expect.poll(() => greenPixels(page)).toBeGreaterThan(100);
  await page.screenshot({ path: info.outputPath("personal-frame-review.png") });
  const exportedGreen = await page.evaluate(async () => {
    const exported = await window.__LIGHT_PEN_TEST__!.renderer!.exportPng();
    const image = new Image();
    image.src = exported.dataUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4)
      if (data[i + 1] > data[i] + 40 && data[i + 1] > data[i + 2] + 40) count++;
    return count;
  });
  expect(exportedGreen).toBe(0);
  await page.evaluate(() =>
    window.__LIGHT_PEN_TEST__!.editor.setCamera({ x: 300, y: 200, zoom: 0.05 }),
  );
  await expect.poll(() => greenPixels(page)).toBeGreaterThan(10);
  await page.getByRole("button", { name: "Фреймы доски", exact: true }).click();
  const list = page.getByRole("complementary", { name: "Фреймы", exact: true });
  await list
    .getByRole("checkbox", { name: "Только непросмотренные", exact: true })
    .check();
  await expect(list.getByText("Глава 1", { exact: true })).toHaveCount(0);
  await expect(list.getByText("Глава 2", { exact: true })).toBeVisible();
  await page.evaluate(() => window.__LIGHT_PEN_TEST__!.saver.flush());
  await page.reload();
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  expect(
    (await service(page, "frame_review", { action: "list" })).frames.find(
      (f: any) => f.id === "frame-a",
    ).viewed,
  ).toBe(true);
});

test("fragment composition exports a portable file and inserts on another page in one undo", async ({
  page,
}, info) => {
  await seed(page, [
    shape("frame", 400, 120, {
      kind: "frame",
      width: 620,
      height: 500,
      text: "Схема",
    }),
    shape("note", 450, 180, { kind: "sticky", text: "Проверить состав" }),
    shape("image", 680, 180, { kind: "image" }),
    shape("formula", 450, 350, { kind: "math", text: "\\frac{a}{b}" }),
    shape("link", 680, 350, {
      kind: "link",
      text: "К заметке",
      link: { path: "", pageId: "main", elementId: "note" },
    }),
  ]);
  await page.evaluate(() => {
    const editor = window.__LIGHT_PEN_TEST__!.editor;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 4;
    canvas.getContext("2d")!.fillRect(0, 0, 4, 4);
    editor.patchElement("image", { dataUrl: canvas.toDataURL("image/png") });
    editor.selected = new Set(["frame"]);
    editor.emit("ui");
  });
  await service(page, "fragment_ui", { action: "open" });
  const dialog = page.getByRole("dialog", {
    name: "Перенести фрагмент",
    exact: true,
  });
  await expect(dialog.getByRole("checkbox")).toHaveCount(5);
  await expect(
    dialog.getByRole("checkbox", { name: "Проверить состав", exact: true }),
  ).toBeChecked();
  await page.screenshot({ path: info.outputPath("fragment-composition.png") });
  const downloading = page.waitForEvent("download");
  await dialog
    .getByRole("button", { name: "Сохранить файл…", exact: true })
    .click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.lightpen-fragment$/);
  const text = await readFile((await download.path())!, "utf8");
  const fragment = JSON.parse(text);
  expect(fragment.elements).toHaveLength(5);
  expect(
    fragment.elements.find((e: any) => e.id === "image").dataUrl,
  ).toContain("data:image/png");
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.evaluate(() =>
    window.__LIGHT_PEN_TEST__!.editor.switchPage("other"),
  );
  await page
    .getByLabel("Файл фрагмента", { exact: true })
    .setInputFiles({
      name: "перенос.lightpen-fragment",
      mimeType: "application/json",
      buffer: Buffer.from(text),
    });
  const importing = page.getByRole("dialog", {
    name: "Вставить фрагмент",
    exact: true,
  });
  await importing
    .getByRole("button", { name: "Вставить", exact: true })
    .click();
  await expect(importing).toHaveCount(0);
  const copied = await page.evaluate(
    () => window.__LIGHT_PEN_TEST__!.editor.elements,
  );
  expect(copied).toHaveLength(5);
  expect(
    copied.every(
      (e) =>
        e.pageId === "other" &&
        !fragment.elements.some((old: any) => old.id === e.id),
    ),
  ).toBe(true);
  const link = copied.find((e) => e.kind === "link")!;
  const note = copied.find((e) => e.kind === "sticky")!;
  expect(link.link).toMatchObject({ pageId: "other", elementId: note.id });
  expect(copied.find((e) => e.kind === "math")!.text).toBe("\\frac{a}{b}");
  await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.undo());
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements.length,
    ),
  ).toBe(0);
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.document.elements.length,
    ),
  ).toBe(5);
});

test("fragment clipboard respects text input and invalid assets cannot partially insert", async ({
  page,
}) => {
  await seed(page, [
    shape("note", 440, 200, { kind: "sticky", text: "Текст" }),
  ]);
  await page.evaluate(() => {
    const editor = window.__LIGHT_PEN_TEST__!.editor;
    editor.selected = new Set(["note"]);
  });
  const fragment = await service(page, "fragment_read");
  const text =
    "application/vnd.lightpen.fragment+json\n" + JSON.stringify(fragment);
  await page.evaluate(() =>
    window.__LIGHT_PEN_TEST__!.editor.switchPage("other"),
  );
  await page.evaluate((text) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", text);
    window.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, text);
  await expect
    .poll(() =>
      page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.elements.length),
    )
    .toBe(1);
  const before = await page.evaluate(() =>
    JSON.stringify(window.__LIGHT_PEN_TEST__!.editor.document),
  );
  const invalid = {
    ...fragment,
    elements: [
      fragment.elements[0],
      shape("bad-image", 700, 200, {
        kind: "image",
        dataUrl: "data:image/png;base64,AAAA",
      }),
    ],
  };
  const error = await page.evaluate(async (fragment) => {
    try {
      await window.__LIGHT_PEN_TEST__!.editor.services.get("fragment_import")!({
        fragment,
      });
      return null;
    } catch (error) {
      return String(error);
    }
  }, invalid);
  expect(error).not.toBeNull();
  expect(
    await page.evaluate(() =>
      JSON.stringify(window.__LIGHT_PEN_TEST__!.editor.document),
    ),
  ).toBe(before);
  await page.evaluate(() => {
    const editor = window.__LIGHT_PEN_TEST__!.editor;
    editor.startText(editor.elements[0], false);
  });
  const intercepted = await page
    .getByRole("textbox", { name: "Текст объекта", exact: true })
    .evaluate((target, text) => {
      const transfer = new DataTransfer();
      transfer.setData("text/plain", text);
      const event = new ClipboardEvent("paste", {
        clipboardData: transfer,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
      return event.defaultPrevented;
    }, text);
  expect(intercepted).toBe(false);
});
