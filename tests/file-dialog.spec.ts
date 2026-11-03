import { test, expect } from "@playwright/test";
test("waiting for file selection does not show a misleading loading overlay", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
  const doc = await page.evaluate(
    () => window.__LIGHT_PEN_TEST__!.editor.document,
  );
  await page.getByRole("button", { name: "Меню файла" }).click();
  const picker = page.waitForEvent("filechooser");
  await page.getByRole("menuitem", { name: "Открыть… Ctrl+O" }).click();
  const chooser = await picker;
  await expect(page.locator(".busy-overlay")).toHaveCount(0);
  await chooser.setFiles({
    name: "Доска.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ ...doc, title: "Доска из файла" })),
  });
  await expect(
    page.getByRole("textbox", { name: "Название доски" }),
  ).toHaveValue("Доска из файла");
  await expect(page.locator(".busy-overlay")).toHaveCount(0);
});
