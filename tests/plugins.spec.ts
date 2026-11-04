import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
const example = JSON.parse(
  readFileSync("plugins/examples/ideas.lightpen-plugin", "utf8"),
);
const policy = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).app
  .security.csp;
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await page.evaluate(() => {
    const { editor } = window.__LIGHT_PEN_TEST__!;
    editor.commitWorkspace([], editor.pages, "Clear");
    editor.history.clear();
  });
});
test("real isolated plugin adds objects and widgets in one undo; fallback survives removal and export", async ({
  page,
}, info) => {
  const result = await page.evaluate(async (bundle) => {
    const { editor, plugins } = window.__LIGHT_PEN_TEST__!;
    await plugins.ready;
    await plugins.install(bundle);
    await plugins.enable(bundle.manifest.id, {
      permissions: ["board:read", "board:write"],
    });
    await plugins.invoke("lightpen.ideas/ideas", {
      title: "Проверенная идея",
      count: 3,
      color: "#fff1a8",
    });
    const count = editor.elements.length;
    editor.undo();
    const afterUndo = editor.elements.length;
    editor.redo();
    await plugins.invoke("lightpen.ideas/counter", {
      title: "Счётчик",
      value: 7,
    });
    const widget = editor.elements.find((e) => e.widget)!;
    editor.selected = new Set([widget.id]);
    await plugins.invoke("lightpen.ideas/increment", {});
    const value = editor.elements.find((e) => e.widget)!.widget!.data;
    await plugins.remove("lightpen.ideas");
    const stored = editor.document;
    const path = "/src/export/index.ts";
    const { captureExportSnapshot, generateExport } = await import(path);
    const png = await generateExport(
      captureExportSnapshot(stored, { selectionIds: [widget.id] }),
      { format: "png", scope: "selection", scale: 2 },
    );
    return {
      count,
      afterUndo,
      value,
      widget: editor.elements.find((e) => e.widget),
      bytes: [...new Uint8Array(await png.blob.arrayBuffer())],
      iframes: document.querySelectorAll("iframe").length,
    };
  }, example);
  expect(result.count).toBe(3);
  expect(result.afterUndo).toBe(0);
  expect(result.value).toMatchObject({ value: 8 });
  expect(result.widget!.widget!.fallback).toContain("8");
  expect(result.iframes).toBe(0);
  const fs = await import("node:fs/promises");
  await fs.writeFile(
    info.outputPath("widget-without-plugin.png"),
    Buffer.from(result.bytes),
  );
  await page.screenshot({
    path: info.outputPath("widget-without-plugin-on-board.png"),
  });
});
test("a widget without its plugin draws readable fallback text on the board and in PNG", async ({
  page,
}, info) => {
  const pixels = await page.evaluate(async () => {
    const path = "/src/editor/model/types.ts";
    const { createElement, DEFAULT_STYLE } = await import(path);
    const { editor } = window.__LIGHT_PEN_TEST__!;
    const widget = {
      ...createElement("rectangle", 440, 180, DEFAULT_STYLE),
      width: 400,
      height: 160,
      fontSize: 28,
      fill: "#d5edff",
      text: "Outdated text",
      widget: {
        pluginId: "test.absent",
        type: "counter",
        version: 1,
        data: { value: 42 },
        fallback: "Readable fallback\nCounter: 42",
      },
    };
    editor.commit([widget], "Widget fixture");
    editor.setCamera({ x: 0, y: 0, zoom: 1 });
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const countText = (data: Uint8ClampedArray) => {
      let count = 0;
      for (let i = 0; i < data.length; i += 4)
        if (
          data[i] < 80 &&
          data[i + 1] < 80 &&
          data[i + 2] < 80 &&
          data[i + 3] > 200
        )
          count++;
      return count;
    };
    const board = document.querySelector<HTMLCanvasElement>(".board-canvas")!;
    const ratio = board.width / board.getBoundingClientRect().width;
    const live = countText(
      board
        .getContext("2d")!
        .getImageData(
          Math.round(465 * ratio),
          Math.round(200 * ratio),
          Math.round(350 * ratio),
          Math.round(110 * ratio),
        ).data,
    );
    const exportPath = "/src/export/index.ts";
    const { captureExportSnapshot, generateExport } = await import(exportPath);
    const output = await generateExport(
      captureExportSnapshot(editor.document),
      {
        format: "png",
        scope: "page",
        scale: 1,
      },
    );
    const bitmap = await createImageBitmap(output.blob);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const exported = countText(
      ctx.getImageData(0, 0, canvas.width, canvas.height).data,
    );
    return { live, exported };
  });
  expect(pixels.live).toBeGreaterThan(150);
  expect(pixels.exported).toBeGreaterThan(150);
  await page.screenshot({
    path: info.outputPath("widget-readable-fallback.png"),
  });
});
test("production CSP permits only the fixed bootstrap; plugin code cannot see app storage, DOM, invoke or direct network", async ({
  page,
}) => {
  const result = await page.evaluate(
    async ({ bundle, policy }) => {
      const meta = document.createElement("meta");
      meta.httpEquiv = "Content-Security-Policy";
      meta.content = policy;
      document.head.append(meta);
      bundle.manifest.id = "test.probe";
      bundle.manifest.name = "Probe";
      bundle.manifest.permissions = [];
      bundle.manifest.commands = [
        { id: "probe", title: "Probe", readOnly: true },
      ];
      delete bundle.manifest.panels;
      delete bundle.manifest.widgets;
      bundle.code =
        'LightPen.register({probe:async()=>{let blocked=false;try{await fetch("https://example.com/?lightpen-test");}catch{blocked=true;}return{dom:typeof document,storage:typeof localStorage,invoke:typeof globalThis.__TAURI_INTERNALS__,worker:typeof Worker,blocked};}});';
      const host = window.__LIGHT_PEN_TEST__!.plugins;
      await host.install(bundle);
      await host.enable(bundle.manifest.id, { permissions: [] });
      return host.invoke("test.probe/probe");
    },
    { bundle: example, policy },
  );
  expect(result).toEqual({
    dom: "undefined",
    storage: "undefined",
    invoke: "undefined",
    worker: "undefined",
    blocked: true,
  });
});
test("a looping plugin is terminated while the board remains responsive and unchanged", async ({
  page,
}) => {
  const result = await page.evaluate(async (bundle) => {
    const path = "/src/plugins/host.ts";
    const { PluginHost } = await import(path);
    const editor = window.__LIGHT_PEN_TEST__!.editor;
    bundle.manifest.id = "test.loop";
    bundle.manifest.name = "Loop";
    bundle.manifest.commands = [{ id: "loop", title: "Loop" }];
    bundle.manifest.permissions = [];
    delete bundle.manifest.panels;
    delete bundle.manifest.widgets;
    bundle.code = "LightPen.register({loop:()=>{while(true){}}});";
    const host = new PluginHost(editor, { timeoutMs: 1000 });
    await host.ready;
    await host.install(bundle);
    await host.enable("test.loop", { permissions: [] });
    const before = editor.document.revision;
    let ticks = 0;
    const interval = setInterval(() => {
      ticks++;
    }, 30);
    const start = performance.now();
    let error = "";
    try {
      await host.invoke("test.loop/loop");
    } catch (e) {
      error = String(e);
    }
    clearInterval(interval);
    host.dispose();
    return {
      error,
      ticks,
      elapsed: performance.now() - start,
      unchanged: before === editor.document.revision,
      iframes: document.querySelectorAll("iframe").length,
    };
  }, example);
  expect(result.error).toContain("PLUGIN_TIMEOUT");
  expect(result.ticks).toBeGreaterThan(5);
  expect(result.elapsed).toBeLessThan(4000);
  expect(result.unchanged).toBe(true);
  expect(result.iframes).toBe(0);
});
test("extension management and declarative controls occupy a dialog, with no permanent canvas controls", async ({
  page,
}, info) => {
  await page.evaluate(async (bundle) => {
    const host = window.__LIGHT_PEN_TEST__!.plugins;
    await host.install(bundle);
    await host.enable(bundle.manifest.id, {
      permissions: ["board:read", "board:write"],
    });
  }, example);
  await page.getByRole("button", { name: "Меню файла", exact: true }).click();
  await page.getByRole("menuitem", { name: "Плагины…", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Расширения", exact: true });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("button", { name: "Идеи по сетке", exact: true })
    .click();
  await dialog
    .getByRole("textbox", { name: "Тема", exact: true })
    .fill("Новая глава");
  await dialog
    .getByRole("spinbutton", {
      name: "Количество — точное значение",
      exact: true,
    })
    .fill("4");
  await dialog.getByRole("button", { name: "Выполнить", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Создано объектов: 4");
  await page.screenshot({
    path: info.outputPath("fluent-extension-controls.png"),
  });
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements.length,
    ),
  ).toBe(4);
});
