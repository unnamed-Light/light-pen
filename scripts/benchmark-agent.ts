import { Editor } from "../src/editor/editor.ts";
import { AgentController } from "../src/agent/controller.ts";
import {
  createDocument,
  createElement,
  DEFAULT_STYLE,
} from "../src/editor/model/types.ts";
import { writeFile } from "node:fs/promises";
const e = new Editor();
e.setDocument({
  ...createDocument(),
  elements: Array.from({ length: 10000 }, (_, i) => ({
    ...createElement(
      "rectangle",
      (i % 100) * 150,
      Math.floor(i / 100) * 110,
      DEFAULT_STYLE,
    ),
    id: "shape" + i,
    width: 120,
    height: 80,
  })),
});
const a = new AgentController(e);
a.enable({ session: "benchmark", write: true, files: false, network: false });
const samples = [];
for (let i = 0; i < 24; i++) {
  const start = performance.now();
  await a.call("edit_batch", {
    session: a.grant!.session,
    requestId: crypto.randomUUID(),
    documentId: e.document.id,
    expectedRevision: e.document.revision,
    operations: [{ op: "update", id: "shape" + i, patch: { x: i * 20 } }],
  });
  samples.push(performance.now() - start);
}
const sorted = [...samples].sort((a, b) => a - b),
  result = {
    objects: e.elements.length,
    operations: samples.length,
    p95: sorted[Math.floor(sorted.length * 0.95)],
    max: sorted.at(-1),
    samples,
  };
await writeFile(
  "reports/agent-api-performance.json",
  JSON.stringify(result, null, 2),
);
console.log(JSON.stringify(result));
