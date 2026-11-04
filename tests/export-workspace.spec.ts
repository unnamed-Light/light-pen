import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { unzipSync } from "fflate";

const artifactRoot = resolve("reports/export-workspace");
const shape = (
  id: string,
  pageId = "one",
  extra: Record<string, unknown> = {},
) => ({
  id,
  pageId,
  kind: "rectangle",
  x: 0,
  y: 0,
  width: 80,
  height: 40,
  color: "#e00000",
  fill: "#e00000",
  strokeWidth: 1,
  opacity: 1,
  createdAt: 1,
  fontSize: 24,
  ...extra,
});
async function seed(
  page: Page,
  elements: unknown[],
  pages = [
    { id: "one", title: "Первая / страница" },
    { id: "two", title: "Вторая страница" },
  ],
) {
  await page.evaluate(
    ({ elements, pages }) => {
      const e = window.__LIGHT_PEN_TEST__!.editor;
      e.setDocument({
        ...e.document,
        id: crypto.randomUUID(),
        schemaVersion: 5,
        title: "Экспорт пространства",
        pages,
        elements: elements as typeof e.elements,
        revision: 0,
      });
      e.setTool("select");
      e.snap = false;
    },
    { elements, pages },
  );
}
test.beforeEach(async ({ page }) => {
  await mkdir(artifactRoot, { recursive: true });
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await seed(page, [shape("red")]);
});

test("PNG exports use exact 1x, 2x, 4x and custom dimensions; region transparency is real", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const path = "/src/export/index.ts";
    const { captureExportSnapshot, generateExport } = await import(path);
    const snapshot = captureExportSnapshot(
      window.__LIGHT_PEN_TEST__!.editor.document,
      { activePageId: "one" },
    );
    const sizes: number[][] = [];
    for (const scale of [1, 2, 4]) {
      const file = await generateExport(snapshot, {
        format: "png",
        scope: "page",
        padding: 0,
        scale,
      });
      const image = await createImageBitmap(file.blob);
      sizes.push([image.width, image.height]);
      image.close();
    }
    const custom = await generateExport(snapshot, {
      format: "png",
      scope: "page",
      padding: 0,
      pixelWidth: 777,
    });
    const customImage = await createImageBitmap(custom.blob);
    sizes.push([customImage.width, customImage.height]);
    customImage.close();
    const file = await generateExport(snapshot, {
      format: "png",
      scope: "region",
      region: { x: -10, y: -10, width: 100, height: 80 },
      transparent: true,
      scale: 1,
    });
    const image = await createImageBitmap(file.blob);
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const c = canvas.getContext("2d")!;
    c.drawImage(image, 0, 0);
    image.close();
    return {
      sizes,
      corner: [...c.getImageData(0, 0, 1, 1).data],
      red: [...c.getImageData(20, 20, 1, 1).data],
      bytes: [...new Uint8Array(await file.blob.arrayBuffer())],
    };
  });
  expect(result.sizes).toEqual([
    [81, 41],
    [162, 82],
    [324, 164],
    [777, 393],
  ]);
  expect(result.corner[3]).toBe(0);
  expect(result.red).toEqual([224, 0, 0, 255]);
  await writeFile(
    resolve(artifactRoot, "transparent-region.png"),
    Buffer.from(result.bytes),
  );
});

test("workspace ZIP contains distinct PNGs and empty pages while one-image layout has no overlap", async ({
  page,
}) => {
  await seed(
    page,
    [
      shape("red"),
      shape("blue", "two", { color: "#0000e0", fill: "#0000e0" }),
      shape("hidden", "two", { hidden: true, x: 9999, width: 50000 }),
    ],
    [
      { id: "one", title: "Одинаковые / имена" },
      { id: "two", title: "Одинаковые / имена" },
      { id: "empty", title: "Пустая" },
    ],
  );
  const result = await page.evaluate(async () => {
    const path = "/src/export/index.ts";
    const { captureExportSnapshot, generateExport } = await import(path);
    const e = window.__LIGHT_PEN_TEST__!.editor,
      before = JSON.stringify(e.document);
    const snapshot = captureExportSnapshot(e.document, { activePageId: "one" });
    const zip = await generateExport(snapshot, {
      format: "zip",
      scope: "workspace",
      padding: 0,
      scale: 1,
    });
    const png = await generateExport(snapshot, {
      format: "png",
      scope: "pages",
      pageIds: ["one", "two"],
      padding: 0,
      scale: 1,
      layout: { columns: 2, gap: 20 },
    });
    const image = await createImageBitmap(png.blob);
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const c = canvas.getContext("2d")!;
    c.drawImage(image, 0, 0);
    image.close();
    return {
      zip: [...new Uint8Array(await zip.blob.arrayBuffer())],
      width: canvas.width,
      height: canvas.height,
      red: [...c.getImageData(40, 20, 1, 1).data],
      gap: [...c.getImageData(90, 20, 1, 1).data],
      blue: [...c.getImageData(140, 20, 1, 1).data],
      unchanged: JSON.stringify(e.document) === before,
    };
  });
  expect([result.width, result.height]).toEqual([182, 41]);
  expect(result.red).toEqual([224, 0, 0, 255]);
  expect(result.blue).toEqual([0, 0, 224, 255]);
  expect(result.gap).toEqual([255, 255, 255, 255]);
  expect(result.unchanged).toBe(true);
  const zip = Buffer.from(result.zip);
  await writeFile(resolve(artifactRoot, "workspace.zip"), zip);
  const files = unzipSync(zip),
    pngs = Object.keys(files).filter((name) => name.endsWith(".png"));
  expect(pngs).toHaveLength(3);
  expect(pngs.every((name) => !/[\/\\]/.test(name))).toBe(true);
  const sizes = pngs.map((name) => {
    const data = Buffer.from(files[name]);
    return [data.readUInt32BE(16), data.readUInt32BE(20)];
  });
  expect(sizes).toEqual([
    [81, 41],
    [81, 41],
    [800, 600],
  ]);
  const manifest = JSON.parse(
    new TextDecoder().decode(files["light-pen-export.json"]),
  );
  expect(manifest.pages.map((p: { pageId: string }) => p.pageId)).toEqual([
    "one",
    "two",
    "empty",
  ]);
});

test("multipage PDF preserves page order, Cyrillic and formulas; frame pages remain independent", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await seed(page, [
    shape("t1", "one", {
      kind: "text",
      width: 320,
      height: 60,
      text: "Первая страница",
      fontSize: 24,
    }),
    shape("formula", "one", {
      kind: "math",
      y: 80,
      width: 200,
      height: 70,
      text: "\\frac{a}{b}",
      fontSize: 24,
    }),
    shape("t2", "two", {
      kind: "text",
      width: 320,
      height: 60,
      text: "Вторая страница",
      fontSize: 24,
    }),
    shape("secret", "two", { kind: "text", text: "СКРЫТОЕ", hidden: true }),
  ]);
  const bytes = await page.evaluate(async () => {
    const path = "/src/export/index.ts";
    const { captureExportSnapshot, generateExport } = await import(path);
    const file = await generateExport(
      captureExportSnapshot(window.__LIGHT_PEN_TEST__!.editor.document),
      { format: "pdf", scope: "workspace", pdfPageSize: "a4" },
    );
    return [...new Uint8Array(await file.blob.arrayBuffer())];
  });
  const target = resolve(artifactRoot, "pages.pdf");
  await writeFile(target, Buffer.from(bytes));
  const report = JSON.parse(
    execFileSync(
      "python",
      [
        "-c",
        "from pypdf import PdfReader;import sys,json;r=PdfReader(sys.argv[1]);print(json.dumps({'pages':len(r.pages),'text':[p.extract_text() for p in r.pages]},ensure_ascii=True))",
        target,
      ],
      { encoding: "utf8" },
    ),
  );
  expect(report.pages).toBe(2);
  expect(report.text[0]).toContain("Первая страница");
  expect(report.text[1]).toContain("Вторая страница");
  expect(report.text.join(" ")).not.toContain("СКРЫТОЕ");
  await writeFile(
    resolve(artifactRoot, "pdf-content.json"),
    JSON.stringify(report, null, 2),
  );
  await seed(page, [
    shape("f1", "one", {
      kind: "frame",
      width: 100,
      height: 80,
      text: "Первый",
      slideOrder: 2,
    }),
    shape("f2", "one", {
      kind: "frame",
      x: 200,
      width: 100,
      height: 80,
      text: "Второй",
      slideOrder: 1,
    }),
    shape("inside"),
    shape("inside2", "one", { x: 200 }),
  ]);
  const frames = await page.evaluate(async () => {
    const path = "/src/export/index.ts";
    const { captureExportSnapshot, generateExport } = await import(path);
    const file = await generateExport(
      captureExportSnapshot(window.__LIGHT_PEN_TEST__!.editor.document),
      { format: "pdf", scope: "frames" },
    );
    return {
      bytes: [...new Uint8Array(await file.blob.arrayBuffer())],
      ids: file.plan.pages.map((p: { id: string }) => p.id),
    };
  });
  expect(frames.ids).toEqual(["f2", "f1"]);
  expect(
    Buffer.from(frames.bytes)
      .toString("latin1")
      .match(/\/Type \/Page\b/g),
  ).toHaveLength(2);
  await writeFile(
    resolve(artifactRoot, "frames.pdf"),
    Buffer.from(frames.bytes),
  );
});

test("frozen export survives later board changes; a damaged asset and cancellation yield no partial result", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const path = "/src/export/index.ts";
    const { captureExportSnapshot, generateExport } = await import(path);
    const e = window.__LIGHT_PEN_TEST__!.editor;
    const snapshot = captureExportSnapshot(e.document);
    const pending = generateExport(snapshot, {
      format: "png",
      scope: "page",
      padding: 0,
      scale: 1,
    });
    e.setDocument({
      ...e.document,
      revision: e.document.revision + 1,
      elements: e.elements.map((el) => ({ ...el, fill: "#00ff00" })),
    });
    const file = await pending,
      image = await createImageBitmap(file.blob);
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    image.close();
    const source = structuredClone(snapshot.document);
    source.elements = [
      {
        ...source.elements[0],
        kind: "image",
        dataUrl: "data:image/png;base64,AAAA",
      },
    ];
    let damaged = "";
    try {
      await generateExport(captureExportSnapshot(source), {
        format: "png",
        scope: "page",
      });
    } catch (error) {
      damaged = String(error);
    }
    const abort = new AbortController();
    let canceled = "",
      returned = false;
    try {
      await generateExport(
        snapshot,
        { format: "zip", scope: "workspace", scale: 1 },
        { signal: abort.signal, onProgress: () => abort.abort() },
      );
      returned = true;
    } catch (error) {
      canceled = (error as Error).name;
    }
    return {
      pixel: [...context.getImageData(20, 20, 1, 1).data],
      revision: file.revision,
      currentRevision: e.document.revision,
      damaged,
      canceled,
      returned,
    };
  });
  expect(result.pixel).toEqual([224, 0, 0, 255]);
  expect(result.currentRevision).toBeGreaterThan(result.revision);
  expect(result.damaged).toMatch(/изображение/i);
  expect(result.canceled).toBe("AbortError");
  expect(result.returned).toBe(false);
});

test("export dialog stays calm, exposes exact dimensions and rejects an oversized file visibly", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Экспорт доски", exact: true })
    .click();
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: "Экспорт доски" }) });
  await expect(dialog.locator("details")).not.toHaveAttribute("open", "");
  await expect(dialog.getByRole("combobox")).toHaveCount(2);
  await dialog
    .getByLabel("Формат экспорта", { exact: true })
    .selectOption("png");
  await expect(dialog.getByRole("combobox")).toHaveCount(3);
  await expect(dialog.getByTestId("export-dimensions")).toContainText("258");
  await dialog
    .getByLabel("Масштаб экспорта", { exact: true })
    .selectOption("4");
  await expect(dialog.getByTestId("export-dimensions")).toContainText("516");
  await dialog.getByText("Дополнительно", { exact: true }).click();
  await dialog.getByLabel("Ширина PNG, px", { exact: true }).fill("20000");
  await expect(dialog.getByRole("alert")).toContainText("16 384");
  await expect(
    dialog.getByRole("button", { name: "Экспортировать", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: resolve(artifactRoot, "fluent-export-error.png"),
  });
  await dialog.getByLabel("Ширина PNG, px", { exact: true }).fill("1000");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByTestId("export-dimensions")).toContainText("1 000");
  await page.setViewportSize({ width: 800, height: 560 });
  await expect(
    dialog.getByRole("button", { name: "Экспортировать", exact: true }),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: resolve(artifactRoot, "fluent-export-compact.png"),
  });
});

test("64MP PNG is encoded at the requested dimensions without silent downscaling", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const result = await page.evaluate(async () => {
    const path = "/src/export/index.ts";
    const { captureExportSnapshot, generateExport } = await import(path);
    const start = performance.now();
    const file = await generateExport(
      captureExportSnapshot(window.__LIGHT_PEN_TEST__!.editor.document),
      {
        format: "png",
        scope: "region",
        region: { x: 0, y: 0, width: 16000, height: 4000 },
        scale: 1,
      },
    );
    const buffer = await file.blob.arrayBuffer(),
      header = new DataView(buffer);
    return {
      width: header.getUint32(16),
      height: header.getUint32(20),
      bytes: buffer.byteLength,
      ms: performance.now() - start,
      working: file.plan.estimatedWorkingBytes,
    };
  });
  expect([result.width, result.height]).toEqual([16000, 4000]);
  expect(result.bytes).toBeGreaterThan(24);
  await writeFile(
    resolve(artifactRoot, "64mp-result.json"),
    JSON.stringify(result, null, 2),
  );
});
