import { describe, expect, it } from "vitest";
import { AgentController } from "./controller";
import { Editor } from "../editor/editor";
import { createElement, DEFAULT_STYLE } from "../editor/model/types";
import type { TaskData } from "../editor/model/types";

const existingTaskFields: [string, Partial<TaskData>][] = [
  [
    "long description from the task editor",
    { description: "д".repeat(10_001) },
  ],
  ["large estimate from the task editor", { estimate: 100_001 }],
  ["long tag from the task editor", { tags: ["т".repeat(81)] }],
  [
    "imported checklist",
    {
      items: Array.from({ length: 501 }, (_, i) => ({
        id: `item-${i}`,
        text: `Пункт ${i}`,
        done: i % 2 === 0,
      })),
    },
  ],
  [
    "imported dependencies",
    {
      dependencies: Array.from({ length: 501 }, (_, i) => `dependency-${i}`),
    },
  ],
];

describe("Agent preserves the supported task model", () => {
  it.each(existingTaskFields)(
    "changes status without losing %s",
    async (_description, fields) => {
      const editor = new Editor();
      const task: TaskData = { status: "todo", items: [], ...fields };
      editor.commit(
        [
          {
            ...createElement("task", 100, 200, DEFAULT_STYLE),
            id: "existing-task",
            width: 300,
            height: 200,
            text: "Существующая задача",
            task,
          },
        ],
        "Из интерфейса или открытой доски",
      );
      const agent = new AgentController(editor);
      agent.enable({
        session: "task-session",
        write: true,
        files: false,
        network: false,
      });
      await agent.call("edit_batch", {
        session: agent.grant!.session,
        requestId: crypto.randomUUID(),
        documentId: editor.document.id,
        expectedRevision: editor.document.revision,
        operations: [
          {
            op: "update",
            id: "existing-task",
            patch: { task: { ...task, status: "done" } },
          },
        ],
      });
      expect(editor.elements[0].task).toEqual({ ...task, status: "done" });
      editor.undo();
      expect(editor.elements[0].task).toEqual(task);
    },
  );
});
