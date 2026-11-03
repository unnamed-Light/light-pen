import type { SceneElement } from "../model/types";
interface Entry {
  before: SceneElement[];
  after: SceneElement[];
  label: string;
  beforeTitle?: string;
  afterTitle?: string;
}
export class History {
  restoredTitle: string | undefined;
  private past: Entry[] = [];
  private future: Entry[] = [];
  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }
  get undoLabel() {
    return this.past.at(-1)?.label ?? "";
  }
  push(
    before: SceneElement[],
    after: SceneElement[],
    label: string,
    beforeTitle?: string,
    afterTitle?: string,
  ) {
    this.past.push({ before, after, label, beforeTitle, afterTitle });
    if (this.past.length > 100) this.past.shift();
    this.future = [];
  }
  undo(): SceneElement[] | null {
    this.restoredTitle = undefined;
    const e = this.past.pop();
    if (!e) return null;
    this.future.push(e);
    this.restoredTitle = e.beforeTitle;
    return e.before;
  }
  redo(): SceneElement[] | null {
    this.restoredTitle = undefined;
    const e = this.future.pop();
    if (!e) return null;
    this.past.push(e);
    this.restoredTitle = e.afterTitle;
    return e.after;
  }
  clear() {
    this.past = [];
    this.future = [];
  }
}
