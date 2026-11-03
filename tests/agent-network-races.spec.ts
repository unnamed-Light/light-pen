import { test, expect } from "@playwright/test";
import { createCollaborationServer } from "../server/server";
import { createDocument } from "../src/editor/model/types";

for (const scenario of ["gesture", "revision", "revoked"] as const) {
  test(`agent delayed room connection preserves local work after ${scenario}`, async ({
    page,
  }) => {
    const server = createCollaborationServer({ database: ":memory:" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ticketReached = false;
    try {
      const service = await server.listen();
      const response = await fetch(service + "/v1/rooms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          document: createDocument("Удалённая доска"),
        }),
      });
      expect(response.ok).toBe(true);
      const room = (await response.json()) as { id: string; token: string };

      await page.goto("/");
      await expect(page.getByTestId("app")).toHaveAttribute(
        "data-ready",
        "true",
      );
      const original = await page.evaluate(() => {
        const { editor, agent } = window.__LIGHT_PEN_TEST__!;
        editor.setDocument({
          ...editor.document,
          id: crypto.randomUUID(),
          title: "Исходная локальная доска",
          revision: 0,
          elements: [],
        });
        editor.setTool("pen");
        agent.enable({
          session: crypto.randomUUID(),
          write: true,
          files: false,
          network: true,
        });
        return { id: editor.document.id, revision: editor.document.revision };
      });

      await page.route("**/v1/rooms/*/ticket", async (route) => {
        ticketReached = true;
        await gate;
        await route.continue().catch(() => {});
      });
      await page.evaluate(
        ({ service, room }) => {
          const { editor, agent } = window.__LIGHT_PEN_TEST__!;
          const pending = window as typeof window & {
            __agentNetworkPending?: Promise<unknown>;
          };
          pending.__agentNetworkPending = agent.rpc("tools/call", {
            name: "collaboration",
            arguments: {
              session: agent.grant!.session,
              requestId: crypto.randomUUID(),
              documentId: editor.document.id,
              expectedRevision: editor.document.revision,
              action: "join",
              invitation: service + "/join/" + room.id + "#" + room.token,
            },
          });
        },
        { service, room },
      );
      await expect.poll(() => ticketReached).toBe(true);

      if (scenario === "gesture") {
        const board = (await page.getByTestId("board").boundingBox())!;
        await page.mouse.move(board.x + 600, board.y + 280);
        await page.mouse.down();
        await page.mouse.move(board.x + 820, board.y + 350, { steps: 12 });
        expect(
          await page.evaluate(
            () => window.__LIGHT_PEN_TEST__!.editor.isInteracting,
          ),
        ).toBe(true);
      } else if (scenario === "revision") {
        await page.evaluate(() => {
          window.__LIGHT_PEN_TEST__!.editor.rename(
            "Сохранить правку пользователя",
          );
        });
      } else {
        await page.evaluate(() => window.__LIGHT_PEN_TEST__!.agent.disable());
      }

      release();
      const result = (await page.evaluate(() => {
        const pending = window as typeof window & {
          __agentNetworkPending?: Promise<unknown>;
        };
        return pending.__agentNetworkPending;
      })) as { isError?: boolean; content: { text: string }[] };
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        scenario === "gesture"
          ? "BUSY"
          : scenario === "revision"
            ? "REVISION_CONFLICT"
            : "ACCESS_REVOKED",
      );

      const unchanged = await page.evaluate(async () => {
        const { editor } = window.__LIGHT_PEN_TEST__!;
        return {
          id: editor.document.id,
          revision: editor.document.revision,
          title: editor.document.title,
          interacting: editor.isInteracting,
          elements: editor.elements.length,
          connection: (await editor.services.get("collaboration")!({
            action: "status",
          })) as { connected: boolean },
        };
      });
      expect(unchanged.id).toBe(original.id);
      expect(unchanged.revision).toBe(
        original.revision + (scenario === "revision" ? 1 : 0),
      );
      expect(unchanged.title).toBe(
        scenario === "revision"
          ? "Сохранить правку пользователя"
          : "Исходная локальная доска",
      );
      expect(unchanged.elements).toBe(0);
      expect(unchanged.connection.connected).toBe(false);
      expect(unchanged.interacting).toBe(scenario === "gesture");
      if (scenario === "gesture") {
        await page.mouse.up();
        expect(
          await page.evaluate(
            () => window.__LIGHT_PEN_TEST__!.editor.elements.length,
          ),
        ).toBe(1);
      }
    } finally {
      release();
      await page.mouse.up().catch(() => {});
      await server.close();
    }
  });
}
