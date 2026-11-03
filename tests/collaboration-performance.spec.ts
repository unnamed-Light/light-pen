import { test, expect } from "@playwright/test";
import { writeFile, mkdir } from "node:fs/promises";
import { createCollaborationServer } from "../server/server";
import { createRoom, invitation } from "../src/collaboration/client";
import {
  createDocument,
  createElement,
  DEFAULT_STYLE,
} from "../src/editor/model/types";
test("shared 10000-object scene keeps local editing below the frame budget while changes persist", async ({
  page,
}) => {
  test.setTimeout(180000);
  const server = createCollaborationServer({ database: ":memory:" });
  try {
    const url = await server.listen(),
      document = {
        ...createDocument("Общая нагрузочная доска"),
        elements: Array.from({ length: 10000 }, (_, i) => ({
          ...createElement(
            "rectangle",
            (i % 100) * 180,
            Math.floor(i / 100) * 140,
            DEFAULT_STYLE,
          ),
          width: 140,
          height: 100,
          fill: "#cfe9fd",
        })),
      };
    const room = await createRoom(url, document);
    await page.goto("/");
    await expect(page.getByTestId("app")).toHaveAttribute("data-ready", "true");
    const button = page.getByRole("button", {
      name: "Совместная работа",
      exact: true,
    });
    await button.click();
    await page
      .getByRole("textbox", { name: "Приглашение Light Pen", exact: true })
      .fill(invitation(url, room.id, room.token));
    await page
      .getByRole("button", { name: "Подключиться", exact: true })
      .click();
    await expect(button).toHaveText("Общая доска", { timeout: 30000 });
    await page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
    const local: number[] = [],
      ack: number[] = [];
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
    for (let i = 0; i < 32; i++) {
      const started = performance.now();
      local.push(
        await page.evaluate((i) => {
          const e = window.__LIGHT_PEN_TEST__!.editor;
          const t = performance.now();
          e.commit(
            e.elements.map((el, j) => (j === i ? { ...el, x: el.x + 1 } : el)),
            "Нагрузочное перемещение",
          );
          return performance.now() - t;
        }, i),
      );
      await expect(button).toHaveText("Общая доска", { timeout: 15000 });
      ack.push(performance.now() - started);
    }
    const profile = await cdp.send("Profiler.stop");
    await cdp.detach();
    const sorted = [...local].sort((a, b) => a - b),
      acks = [...ack].sort((a, b) => a - b);
    const report = {
      objects: 10000,
      localSamples: local,
      ackSamples: ack,
      localP95: sorted[Math.ceil(sorted.length * 0.95) - 1],
      localMax: sorted.at(-1),
      ackP95: acks[Math.ceil(acks.length * 0.95) - 1],
      ackMax: acks.at(-1),
      persistedVersion: server.store.db
        .prepare("SELECT version FROM rooms WHERE id=?")
        .get(room.id)!.version,
    };
    await mkdir("reports", { recursive: true });
    await writeFile(
      "reports/v4-shared-browser-performance.json",
      JSON.stringify(report, null, 2),
    );
    if (report.localP95 > 16.7)
      await writeFile(
        "reports/v4-shared-browser-cpu.json",
        JSON.stringify(profile.profile),
      );
    console.log(JSON.stringify(report));
    expect(report.localP95).toBeLessThan(16.7);
    expect(Number(report.persistedVersion)).toBeGreaterThanOrEqual(32);
  } finally {
    await server.close();
  }
});
