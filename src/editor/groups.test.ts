import { expect, test } from "vitest";
import { Editor } from "./editor";
import {
  createDocument,
  createElement,
  DEFAULT_STYLE,
  validateDocument,
} from "./model/types";
import { copyElements } from "./model/relations";
const setup = () => {
  const e = new Editor();
  e.setDocument({
    ...createDocument(),
    elements: [0, 1, 2].map((i) => ({
      ...createElement("rectangle", i * 200, 0, DEFAULT_STYLE),
      id: "shape-" + i,
      width: 120,
      height: 100,
    })),
  });
  return e;
};
test("grouping existing groups preserves nesting; ungroup restores inner group and undo is exact", () => {
  const e = setup();
  e.selected = new Set(["shape-0", "shape-1"]);
  e.group();
  const inner = e.elements[0].groupId;
  expect(inner).toBeTruthy();
  e.selectAll();
  e.group();
  const outer = e.elements[0].groupId;
  expect(outer).not.toBe(inner);
  expect(e.elements[0].groupPath).toEqual([outer, inner]);
  expect(e.elements[2].groupPath).toEqual([outer]);
  validateDocument(e.document);
  const nested = structuredClone(e.document.elements);
  e.ungroup();
  expect(e.elements[0].groupId).toBe(inner);
  expect(e.elements[2].groupId).toBeUndefined();
  e.undo();
  expect(e.elements).toEqual(nested);
});
test("entering group scopes picking and ungrouping to its children; leaving selects the outer group", () => {
  const e = setup();
  e.selected = new Set(["shape-0", "shape-1"]);
  e.group();
  e.selectAll();
  e.group();
  e.enterGroup();
  expect(e.groupScope).toHaveLength(1);
  e.selected = new Set(["shape-0", "shape-1"]);
  e.enterGroup();
  expect(e.groupScope).toHaveLength(2);
  expect(e.pick({ x: 420, y: 20 })).toBeNull();
  e.leaveGroup();
  expect([...e.selected].sort()).toEqual(["shape-0", "shape-1"]);
  e.leaveGroup();
  expect(e.selected.size).toBe(3);
});
test("copy remaps every level of a nested group without keeping links to original groups", () => {
  const e = setup();
  e.selected = new Set(["shape-0", "shape-1"]);
  e.group();
  e.selectAll();
  e.group();
  const originals = new Set(e.elements.flatMap((e) => e.groupPath ?? [])),
    copies = copyElements(e.elements, 20, 20);
  expect(copies[0].groupPath).toHaveLength(2);
  expect(copies[0].groupPath).toEqual(copies[1].groupPath);
  expect(copies[0].groupPath?.[0]).toBe(copies[2].groupPath?.[0]);
  expect(
    copies.flatMap((e) => e.groupPath ?? []).some((id) => originals.has(id)),
  ).toBe(false);
  validateDocument({ ...createDocument(), elements: copies });
});
test("malformed and legacy-version group paths are rejected instead of flattened", () => {
  const e = setup();
  const bad = { ...e.elements[0], groupId: "g", groupPath: ["g", "g"] };
  expect(() =>
    validateDocument({ ...createDocument(), elements: [bad] }),
  ).toThrow();
  expect(() =>
    validateDocument({
      ...createDocument(),
      schemaVersion: 3,
      elements: [{ ...bad, groupPath: ["g"] }],
    }),
  ).toThrow();
});
test("new objects inherit the entered group and undo safely leaves a removed scope",()=>{
 const e=setup();e.selected=new Set(["shape-0","shape-1"]);e.group();e.enterGroup();const path=[...e.groupScope];const extra={...createElement("sticky",30,30,DEFAULT_STYLE),text:"Новая заметка",width:100,height:100};e.commit([...e.elements,extra],"New sticky");expect(e.elements.find(x=>x.id===extra.id)?.groupPath).toEqual(path);e.undo();e.undo();expect(e.groupScope).toHaveLength(0);validateDocument(e.document);
});
