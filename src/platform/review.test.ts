import { describe, expect, it } from "vitest";
import { FrameReview } from "./review";

function storage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}

describe("Personal frame review", () => {
  it("persists marks while keeping workspace, page and identity independent", () => {
    const saved = storage();
    let context = { workspaceId: "workspace-a", pageId: "first" };
    const reviews = new FrameReview(
      () => context,
      () => {},
      saved,
    );
    reviews.mark(["frame"]);
    expect(
      new FrameReview(
        () => context,
        () => {},
        saved,
      ).has("frame"),
    ).toBe(true);
    context = { ...context, pageId: "second" };
    expect(reviews.has("frame")).toBe(false);
    reviews.mark(["second-frame"]);
    context = { workspaceId: "workspace-b", pageId: "first" };
    expect(reviews.list()).toEqual([]);
    context = { workspaceId: "workspace-a", pageId: "first" };
    reviews.setIdentity("account:alice");
    expect(reviews.list()).toEqual([]);
    reviews.mark(["alice-frame"]);
    reviews.setIdentity("local");
    expect(reviews.list()).toEqual(["frame"]);
    reviews.setIdentity("account:alice");
    expect(reviews.list()).toEqual(["alice-frame"]);
  });

  it("unmark and clear affect the current page and emit only when preferences change", () => {
    const saved = storage();
    let pageId = "one",
      changed = 0;
    const reviews = new FrameReview(
      () => ({ workspaceId: "workspace", pageId }),
      () => {
        changed++;
      },
      saved,
    );
    reviews.mark(["a", "b"]);
    reviews.mark(["a"]);
    expect(changed).toBe(1);
    reviews.mark(["a"], false);
    expect(reviews.list()).toEqual(["b"]);
    pageId = "two";
    reviews.mark(["c"]);
    reviews.clear();
    pageId = "one";
    expect(reviews.list()).toEqual(["b"]);
    expect(changed).toBe(4);
  });

  it("ignores damaged preferences and retains session marks when storage is unavailable", () => {
    const saved = {
      getItem: () => "{broken",
      setItem: () => {
        throw Error("full");
      },
      removeItem: () => {
        throw Error("denied");
      },
    };
    const reviews = new FrameReview(
      () => ({ workspaceId: "workspace", pageId: "page" }),
      () => {},
      saved,
    );
    expect(reviews.list()).toEqual([]);
    expect(() => reviews.mark(["a"])).not.toThrow();
    expect(reviews.has("a")).toBe(true);
    expect(() => reviews.clear()).not.toThrow();
    expect(reviews.list()).toEqual([]);
  });

  it("rejects an invalid mark packet before changing any personal state", () => {
    const reviews = new FrameReview(
      () => ({ workspaceId: "workspace", pageId: "page" }),
      () => {},
      storage(),
    );
    reviews.mark(["existing"]);
    expect(() => reviews.mark(["new", ""])).toThrow();
    expect(reviews.list()).toEqual(["existing"]);
  });
});
