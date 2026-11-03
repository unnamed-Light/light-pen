import { expect, test } from "@playwright/test";
test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await page.evaluate(() => {
    const e = window.__LIGHT_PEN_TEST__!.editor;
    e.setDocument({
      ...e.document,
      id: crypto.randomUUID(),
      elements: [],
      revision: 0,
    });
    e.setCamera({ x: 0, y: 0, zoom: 1 });
  });
  await page.getByRole("button", { name: "Стикер (N)", exact: true }).click();
});
test("dragged sticky dimensions survive text editing, resize, undo and reload", async ({
  page,
}) => {
  const b = (await page.getByTestId("board").boundingBox())!;
  await page.mouse.move(b.x + 420, b.y + 230);
  await page.mouse.down();
  await page.mouse.move(b.x + 900, b.y + 530, { steps: 25 });
  await page.mouse.up();
  const text = page.getByRole("textbox", { name: "Текст объекта" });
  await expect(text).toHaveCSS("width", "480px");
  await expect(text).toHaveCSS("height", "300px");
  await text.fill("Стикер собственного размера\n日本語");
  await text.press("Control+Enter");
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements[0].width,
    ),
  ).toBe(480);
  await page
    .getByRole("button", { name: "Выделение (V)", exact: true })
    .click();
  await page.mouse.move(b.x + 901.5, b.y + 531.5);
  await page.mouse.down();
  await page.mouse.move(b.x + 1000, b.y + 600, { steps: 15 });
  await page.mouse.up();
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements[0].width,
    ),
  ).toBeGreaterThan(480);
  await page.keyboard.press("Control+z");
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements[0].width,
    ),
  ).toBe(480);
  await page.evaluate(() => window.__LIGHT_PEN_TEST__!.saver.flush());
  await page.reload();
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  expect(
    await page.evaluate(() => ({
      width: window.__LIGHT_PEN_TEST__!.editor.elements[0].width,
      height: window.__LIGHT_PEN_TEST__!.editor.elements[0].height,
    })),
  ).toEqual({ width: 480, height: 300 });
});
test("reverse drag, click default and cancelled sticky gestures behave predictably", async ({
  page,
}) => {
  const b = (await page.getByTestId("board").boundingBox())!;
  await page.mouse.move(b.x + 950, b.y + 530);
  await page.mouse.down();
  await page.mouse.move(b.x + 550, b.y + 280, { steps: 20 });
  await page.mouse.up();
  await expect(page.getByRole("textbox", { name: "Текст объекта" })).toHaveCSS(
    "width",
    "400px",
  );
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements.length,
    ),
  ).toBe(0);
  await page.mouse.move(b.x + 400, b.y + 250);
  await page.mouse.down();
  await page.mouse.move(b.x + 700, b.y + 500);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(
    page.getByRole("textbox", { name: "Текст объекта" }),
  ).toHaveCount(0);
  await page.mouse.click(b.x + 400, b.y + 250);
  await expect(page.getByRole("textbox", { name: "Текст объекта" })).toHaveCSS(
    "width",
    "220px",
  );
  await expect(page.getByRole("textbox", { name: "Текст объекта" })).toHaveCSS(
    "height",
    "180px",
  );
  await page.getByRole("button", { name: "Рука (H)", exact: true }).click();
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements[0].text,
    ),
  ).toBe("");
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.elements.length,
    ),
  ).toBe(1);
});
