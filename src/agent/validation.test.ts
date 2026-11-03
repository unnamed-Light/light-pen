import { it, expect } from "vitest";
import { CandidateValidator } from "./validation";
import {
  createDocument,
  createElement,
  DEFAULT_STYLE,
} from "../editor/model/types";
const el = (id: string, text: string) => ({
  ...createElement("sticky", 0, 0, DEFAULT_STYLE),
  id,
  width: 200,
  height: 100,
  text,
});
it("counts exact UTF-8 JSON bytes, reuses immutable geometry and validates replaced objects", () => {
  const v = new CandidateValidator(),
    a = el("a", 'Русский 日本語 🙂\n"'),
    doc = { ...createDocument(), elements: [a] };
  v.validate(doc);
  expect(v.jsonBytes).toBe(
    new TextEncoder().encode(JSON.stringify(doc)).length,
  );
  const b = el("b", "B");
  const next = { ...doc, elements: [a, b] };
  v.validate(next);
  expect(v.jsonBytes).toBe(
    new TextEncoder().encode(JSON.stringify(next)).length,
  );
  expect(() =>
    v.validate({ ...next, elements: [a, { ...b, fill: "invalid" }] }),
  ).toThrow();
  expect(() => v.validate({ ...next, elements: [a, a] })).toThrow("Duplicate");
});
it("rejects total size and duplicate cached identities without poisoning the previous valid state", () => {
  const doc = { ...createDocument(), elements: [el("a", "small")] },
    v = new CandidateValidator(1000);
  v.validate(doc);
  const bytes = v.jsonBytes;
  expect(() =>
    v.validate({
      ...doc,
      elements: [...doc.elements, el("b", "x".repeat(2000))],
    }),
  ).toThrow("64 MB");
  expect(v.jsonBytes).toBe(bytes);
  expect(() => v.validate(doc)).not.toThrow();
});
