import { describe, expect, it, vi } from "vitest";
import { SaveCoordinator } from "./persistence";
import { createDocument } from "../editor/model/types";

describe("serial autosave", () => {
  it("coalesces bursts and writes only the latest snapshot", async () => {
    const persist = vi.fn(async () => {}),
      saver = new SaveCoordinator({ persist });
    const doc = createDocument();
    for (let i = 0; i < 100; i++) saver.schedule({ ...doc, revision: i });
    await saver.flush();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]).toEqual([{ ...doc, revision: 99 }, null]);
    expect(saver.status).toBe("saved");
    saver.dispose();
  });
  it("never acknowledges newer edits with an older receipt and never writes concurrently", async () => {
    let release!: () => void;
    let active = 0,
      maxActive = 0;
    const revisions: number[] = [];
    const persist = vi.fn(async (doc: ReturnType<typeof createDocument>) => {
      active++;
      maxActive = Math.max(maxActive, active);
      revisions.push(doc.revision);
      if (doc.revision === 1)
        await new Promise<void>((resolve) => (release = resolve));
      active--;
    });
    const saver = new SaveCoordinator({ persist }),
      doc = createDocument();
    saver.schedule({ ...doc, revision: 1 });
    const pending = saver.flush();
    expect(saver.status).toBe("saving");
    saver.schedule({ ...doc, revision: 2 });
    saver.schedule({ ...doc, revision: 3 });
    expect(saver.status).toBe("pending");
    release();
    await pending;
    expect(revisions).toEqual([1, 3]);
    expect(maxActive).toBe(1);
    expect(saver.status).toBe("saved");
    saver.dispose();
  });
  it("retains failed work for retry and surfaces the error", async () => {
    let fail = true;
    const persist = vi.fn(async () => {
      if (fail) throw new Error("Disk full");
    });
    const saver = new SaveCoordinator({ persist });
    saver.schedule(createDocument());
    await expect(saver.flush()).rejects.toThrow("Disk full");
    expect(saver.status).toBe("error");
    expect(saver.error).toBe("Disk full");
    fail = false;
    await saver.flush();
    expect(saver.status).toBe("saved");
    expect(persist).toHaveBeenCalledTimes(2);
    saver.dispose();
  });
  it("newer work supersedes a failed older snapshot", async () => {
    let reject!: (error: Error) => void;
    const revisions: number[] = [];
    let first = true;
    const saver = new SaveCoordinator({
      persist: async (doc) => {
        revisions.push(doc.revision);
        if (first) {
          first = false;
          await new Promise<void>((_, r) => (reject = r));
        }
      },
    });
    const doc = createDocument();
    saver.schedule({ ...doc, revision: 1 });
    const pending = saver.flush();
    saver.schedule({ ...doc, revision: 2 });
    reject(new Error("Disconnected"));
    await expect(pending).rejects.toThrow();
    await saver.flush();
    expect(revisions).toEqual([1, 2]);
    saver.dispose();
  });
  it("defers autosave during gestures and flush bypasses that delay", async () => {
    vi.useFakeTimers();
    let idle = false;
    const persist = vi.fn(async () => {}),
      saver = new SaveCoordinator({ persist }, () => idle, 50);
    saver.schedule(createDocument());
    await vi.advanceTimersByTimeAsync(1000);
    expect(persist).not.toHaveBeenCalled();
    idle = true;
    await vi.advanceTimersByTimeAsync(250);
    expect(persist).toHaveBeenCalledTimes(1);
    saver.dispose();
    vi.useRealTimers();
  });
  it("does not switch documents with unflushed work", () => {
    const saver = new SaveCoordinator({ persist: async () => {} });
    saver.schedule(createDocument());
    expect(() => saver.reset("another.lightpen")).toThrow();
    saver.dispose();
  });
});
