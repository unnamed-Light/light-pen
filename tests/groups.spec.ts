import { test, expect } from "@playwright/test";
test("nested group navigation, scoped creation and save/reload retain hierarchy", async ({
  page,
}, info) => {
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  await page.evaluate(() => {
    const e = window.__LIGHT_PEN_TEST__!.editor,
      now = new Date().toISOString();
    e.setDocument({
      schemaVersion: 4,
      id: crypto.randomUUID(),
      title: "Вложенные группы",
      revision: 0,
      createdAt: now,
      updatedAt: now,
      elements: [0, 1, 2].map((i) => ({
        id: "nested-" + i,
        kind: "rectangle",
        x: 440 + i * 210,
        y: 170,
        width: 150,
        height: 110,
        color: "#0f6cbd",
        fill: "#cfe9fd",
        strokeWidth: 2,
        opacity: 1,
        createdAt: Date.now(),
      })),
    });
    e.setCamera({ x: 0, y: 0, zoom: 1 });
    e.setTool("select");
    e.selected = new Set(["nested-0", "nested-1"]);
    e.emit("ui");
  });
  await page.keyboard.press("Control+g");
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+g");
  await page
    .getByRole("button", { name: "Войти в группу", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Группа 1", exact: true }),
  ).toBeVisible();
  const box = (await page.getByTestId("board").boundingBox())!;
  await page.mouse.click(box.x + 510, box.y + 225);
  await page
    .getByRole("button", { name: "Войти в группу", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Группа 2", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Прямоугольник (R)", exact: true })
    .click();
  await page.mouse.move(box.x + 480, box.y + 400);
  await page.mouse.down();
  await page.mouse.move(box.x + 620, box.y + 500, { steps: 8 });
  await page.mouse.up();
  expect(
    await page.evaluate(
      () =>
        window.__LIGHT_PEN_TEST__!.editor.elements.at(-1)?.groupPath?.length,
    ),
  ).toBe(2);
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.groupScope.length,
    ),
  ).toBe(1);
  await page.keyboard.press("Escape");
  expect(
    await page.evaluate(
      () => window.__LIGHT_PEN_TEST__!.editor.groupScope.length,
    ),
  ).toBe(0);
  const before = await page.evaluate(
    () => window.__LIGHT_PEN_TEST__!.editor.elements,
  );
  await expect(page.getByTestId("save-status")).toContainText("сохранён");
  await page.reload();
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  expect(
    await page.evaluate(() => window.__LIGHT_PEN_TEST__!.editor.elements),
  ).toEqual(before);
  await page.screenshot({ path: info.outputPath("nested-groups.png") });
});
