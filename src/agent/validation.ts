import { validateDocument } from "../editor/model/types";
import type { BoardDocument, SceneElement } from "../editor/model/types";
/** Editor objects are immutable. Weak keys never retain previous boards. */
export class CandidateValidator {
  private valid = new WeakSet<SceneElement>();
  private sizes = new WeakMap<SceneElement, number>();
  private encoder = new TextEncoder();
  jsonBytes = 0;
  constructor(private maxBytes = 64 * 1024 * 1024) {}
  validate(doc: BoardDocument) {
    const changed = doc.elements.filter((e) => !this.valid.has(e));
    validateDocument({ ...doc, elements: changed });
    const ids = new Set<string>();
    let points = 0,
      bytes =
        this.encoder.encode(JSON.stringify({ ...doc, elements: [] })).length +
        Math.max(0, doc.elements.length - 1);
    if (doc.elements.length > 100000)
      throw Error("Document exceeds 100000 objects");
    for (const e of doc.elements) {
      if (ids.has(e.id)) throw Error("Duplicate object ID");
      ids.add(e.id);
      points += e.kind === "stroke" ? (e.points?.length ?? 0) : 0;
      let size = this.sizes.get(e);
      if (size === undefined) {
        size = this.encoder.encode(JSON.stringify(e)).length;
        this.sizes.set(e, size);
      }
      bytes += size;
    }
    if (points > 2000000) throw Error("Document exceeds 2000000 ink points");
    if (bytes > this.maxBytes)
      throw Error(
        "Document exceeds 64 MB; split it before applying this batch",
      );
    changed.forEach((e) => this.valid.add(e));
    this.jsonBytes = bytes;
    return doc;
  }
}
