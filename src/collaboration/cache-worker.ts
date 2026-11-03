import { mergeUpdates } from "yjs";
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<Uint8Array[]>) => void) | null;
  postMessage: (data: unknown, transfer?: Transferable[]) => void;
};
scope.onmessage = (e) => {
  try {
    const state = mergeUpdates(e.data);
    scope.postMessage({ state }, [state.buffer as ArrayBuffer]);
  } catch (error) {
    scope.postMessage({ error: String(error) });
  }
};
