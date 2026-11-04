import type { SceneElement, BoardPage } from "../model/types";
interface Entry {
  before: SceneElement[];
  after: SceneElement[];
  label: string;
  beforeTitle?: string;
  afterTitle?: string;
  beforePages?: BoardPage[];
  afterPages?: BoardPage[];
  beforePageId?: string;
  afterPageId?: string;
}
export class History {
  external: {
    readonly canUndo: boolean;
    readonly canRedo: boolean;
    undo(): void;
    redo(): void;
  } | null = null;
  restoredTitle: string | undefined;
  restoredPages: BoardPage[] | undefined;
  restoredPageId: string | undefined;
  private past: Entry[] = [];
  private future: Entry[] = [];
  get canUndo() {
    if (this.external) return this.external.canUndo;
    return this.past.length > 0;
  }
  get canRedo() {
    if (this.external) return this.external.canRedo;
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
    beforePages?: BoardPage[],
    afterPages?: BoardPage[],
    beforePageId?: string,
    afterPageId?: string,
  ) {
    if (this.external) return;
    this.past.push({
      before,
      after,
      label,
      beforeTitle,
      afterTitle,
      beforePages,
      afterPages,
      beforePageId,
      afterPageId,
    });
    if (this.past.length > 100) this.past.shift();
    this.future = [];
  }
  undo(): SceneElement[] | null {
    if (this.external) {
      this.external.undo();
      return null;
    }
    this.restoredTitle = undefined;
    const e = this.past.pop();
    if (!e) return null;
    this.future.push(e);
    this.restoredTitle = e.beforeTitle;
    this.restoredPages = e.beforePages;
    this.restoredPageId = e.beforePageId;
    return e.before;
  }
  redo(): SceneElement[] | null {
    if (this.external) {
      this.external.redo();
      return null;
    }
    this.restoredTitle = undefined;
    const e = this.future.pop();
    if (!e) return null;
    this.past.push(e);
    this.restoredTitle = e.afterTitle;
    this.restoredPages = e.afterPages;
    this.restoredPageId = e.afterPageId;
    return e.after;
  }
  clear() {
    this.past = [];
    this.future = [];
  }
}
