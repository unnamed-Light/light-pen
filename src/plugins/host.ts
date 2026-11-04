import type { Editor } from "../editor/editor";
import type { SceneElement } from "../editor/model/types";
import { createElement, validateDocument, uid } from "../editor/model/types";
import { resolveBindings } from "../editor/model/relations";
import { CandidateValidator } from "../agent/validation";
import { defaultBackend } from "./backend";
import { SandboxRuntime } from "./sandbox";
import { ProcessRuntime } from "./process";
import {
  jsonValue,
  networkOrigin,
  parsePackage,
  validateArguments,
  validateRegistry,
} from "./validation";
import type {
  HostCall,
  JSONValue,
  Permission,
  PluginBackend,
  PluginEntry,
  PluginGrants,
  PluginGuardContext,
  PluginRegistry,
  PluginRuntime,
  RuntimeFactory,
} from "./types";

interface Transaction {
  entry: PluginEntry;
  elements: SceneElement[];
  documentId: string;
  title: string;
  selection: string[];
  groupScope: string[];
  revision: number;
  page: string | undefined;
  live: boolean;
  writes: number;
  label: string;
  commandReadOnly: boolean;
  agent?: PluginGuardContext;
  data: Record<string, JSONValue>;
  dataChanged: boolean;
}
export interface PluginHostOptions {
  backend?: PluginBackend;
  runtimeFactory?: RuntimeFactory;
  timeoutMs?: number;
}
export class PluginHost {
  readonly ready: Promise<void>;
  readonly backend: PluginBackend;
  guard: (changesDocument: boolean) => void = () => {};
  message = "";
  private entries: PluginEntry[] = [];
  private listeners = new Set<() => void>();
  private snapshot = 0;
  private generation = 0;
  private disabledNow = new Set<string>();
  private active: {
    id: string;
    runtime: PluginRuntime;
    abort: AbortController;
  } | null = null;
  private processes = new Map<string, string>();
  private mutation = Promise.resolve();
  private validator = new CandidateValidator();
  private receipts = new Map<
    string,
    { digest: string; result: Promise<JSONValue> }
  >();
  private receiptBytes = 0;
  private timeoutMs: number;
  private runtimeFactory: RuntimeFactory;
  constructor(
    readonly editor: Editor,
    options: PluginHostOptions = {},
  ) {
    this.backend = options.backend ?? defaultBackend();
    this.timeoutMs = Math.min(15000, Math.max(100, options.timeoutMs ?? 8000));
    this.runtimeFactory =
      options.runtimeFactory ?? ((p, t) => new SandboxRuntime(p, t));
    this.ready = this.load();
    void this.ready.catch(() => {}); // The manager reports registry errors without an unhandled rejection at startup.
  }
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.snapshot;
  private emit() {
    this.snapshot++;
    this.listeners.forEach((fn) => fn());
  }
  private async load() {
    const registry = validateRegistry(await this.backend.load());
    this.entries = registry.entries.map((e) => ({
      ...e,
      enabled:
        e.enabled &&
        e.package.manifest.runtime === "worker" &&
        !e.grants.permissions.some((p) =>
          ["network", "files:read", "files:write"].includes(p),
        ),
    }));
    if (JSON.stringify(this.entries) !== JSON.stringify(registry.entries))
      await this.persist(this.entries);
    this.emit();
  }
  list() {
    return this.entries.map((e) => ({
      manifest: structuredClone(e.package.manifest),
      enabled: e.enabled && !this.disabledNow.has(e.package.manifest.id),
      grants: structuredClone(e.grants),
      running:
        this.active?.id === e.package.manifest.id ||
        this.processes.has(e.package.manifest.id),
    }));
  }
  listCommands() {
    return this.list().flatMap((e) =>
      e.manifest.commands.map((c) => ({
        ...c,
        id: e.manifest.id + "/" + c.id,
        pluginId: e.manifest.id,
        pluginName: e.manifest.name,
        enabled: e.enabled,
        runtime: e.manifest.runtime,
      })),
    );
  }
  listPanels() {
    return this.list().flatMap((e) =>
      (e.manifest.panels ?? []).map((p) => ({
        ...p,
        pluginId: e.manifest.id,
        enabled: e.enabled,
      })),
    );
  }
  private persist(entries: PluginEntry[]) {
    const value: PluginRegistry = { version: 1, entries };
    validateRegistry(value);
    return this.backend.save(value);
  }
  private change(fn: (entries: PluginEntry[]) => PluginEntry[]) {
    const result = this.mutation.then(async () => {
      const next = fn(this.entries);
      await this.persist(next);
      this.entries = next;
      this.emit();
    });
    this.mutation = result.catch(() => {});
    return result;
  }
  async install(input: unknown) {
    await this.ready;
    const bundle = parsePackage(input);
    if (this.entries.some((e) => e.package.manifest.id === bundle.manifest.id))
      throw Error("PLUGIN_EXISTS: use Update for an installed extension");
    if (this.entries.length >= 30)
      throw Error("At most 30 installed extensions");
    await this.change((entries) => [
      ...entries,
      {
        package: bundle,
        enabled: false,
        grants: { permissions: [] },
        data: {},
      },
    ]);
    return bundle.manifest.id;
  }
  async update(input: unknown) {
    await this.ready;
    const bundle = parsePackage(input),
      id = bundle.manifest.id;
    if (!this.entries.some((e) => e.package.manifest.id === id))
      throw Error("Plugin is not installed");
    this.stop(id);
    this.disabledNow.add(id);
    await this.change((entries) =>
      entries.map((e) =>
        e.package.manifest.id === id
          ? {
              ...e,
              package: bundle,
              enabled: false,
              grants: { permissions: [] },
            }
          : e,
      ),
    );
    this.disabledNow.delete(id);
  }
  async enable(id: string, grants: PluginGrants) {
    await this.ready;
    const e = this.entry(id),
      manifest = e.package.manifest;
    if (
      !Array.isArray(grants.permissions) ||
      new Set(grants.permissions).size !== grants.permissions.length ||
      grants.permissions.some((p) => !manifest.permissions.includes(p))
    )
      throw Error("Invalid permission grant");
    if (
      manifest.runtime === "process" &&
      !grants.permissions.includes("process")
    )
      throw Error("Native extension needs explicit process permission");
    const origins = (grants.networkOrigins ?? []).map(networkOrigin);
    if (grants.permissions.includes("network") && !origins.length)
      throw Error("Choose allowed network origins");
    if (
      grants.permissions.some((p) => p.startsWith("files:")) &&
      !grants.folder
    )
      throw Error("Choose a folder for this extension");
    const copy: PluginGrants = {
      permissions: [...grants.permissions],
      ...(grants.folder ? { folder: grants.folder } : {}),
      ...(origins.length ? { networkOrigins: [...new Set(origins)] } : {}),
    };
    await this.change((entries) =>
      entries.map((e) =>
        e.package.manifest.id === id
          ? { ...e, enabled: true, grants: copy }
          : e,
      ),
    );
    this.disabledNow.delete(id);
    this.emit();
  }
  async disable(id: string) {
    await this.ready;
    this.disabledNow.add(id);
    this.stop(id);
    await this.change((entries) =>
      entries.map((e) =>
        e.package.manifest.id === id ? { ...e, enabled: false } : e,
      ),
    );
  }
  async remove(id: string) {
    await this.ready;
    this.disabledNow.add(id);
    this.stop(id);
    await this.change((entries) =>
      entries.filter((e) => e.package.manifest.id !== id),
    );
  }
  private entry(id: string) {
    const entry = this.entries.find((e) => e.package.manifest.id === id);
    if (!entry) throw Error("PLUGIN_NOT_FOUND");
    return entry;
  }
  private stop(id?: string) {
    this.generation++;
    if (this.active && (!id || this.active.id === id)) {
      this.active.abort.abort();
      this.active.runtime.stop();
    }
    for (const [pluginId, processId] of this.processes)
      if (!id || id === pluginId) {
        void this.backend.stopProcess?.(processId).catch(() => {});
        this.processes.delete(pluginId);
      }
    this.emit();
  }
  dispose() {
    this.stop();
    this.listeners.clear();
  }
  async startNative(id: string, acknowledgeRisk: boolean) {
    await this.ready;
    const entry = this.entry(id);
    if (
      !entry.enabled ||
      this.disabledNow.has(id) ||
      entry.package.manifest.runtime !== "process" ||
      !entry.grants.permissions.includes("process")
    )
      throw Error("Native extension is not enabled");
    if (!acknowledgeRisk) throw Error("PROCESS_CONFIRMATION_REQUIRED");
    if (!this.backend.startProcess) throw Error("DESKTOP_REQUIRED");
    this.stop(id);
    const generation = this.generation;
    const processId = await this.backend.startProcess(id, true);
    if (generation !== this.generation || this.disabledNow.has(id)) {
      await this.backend.stopProcess?.(processId);
      throw Error("PLUGIN_DISABLED");
    }
    this.processes.set(id, processId);
    this.emit();
  }
  async invoke(
    commandId: string,
    args: JSONValue = {},
    agent?: PluginGuardContext,
  ): Promise<JSONValue> {
    await this.ready;
    jsonValue(args);
    if (agent) {
      agent.assert();
      if (!agent.requestId.trim()) throw Error("requestId required");
      const key = agent.session + ":" + agent.requestId;
      const digest = JSON.stringify([
        commandId,
        args,
        agent.documentId,
        agent.expectedRevision,
        agent.pageId,
        agent.readOnly,
        agent.files,
        agent.folder,
        agent.network,
      ]);
      const old = this.receipts.get(key);
      if (old) {
        if (old.digest !== digest) throw Error("IDEMPOTENCY_CONFLICT");
        return old.result;
      }
      if (this.receipts.size >= 512 || this.receiptBytes >= 4 * 1024 * 1024)
        throw Error("PLUGIN_SESSION_FULL");
      const result = this.run(commandId, args, agent);
      this.receipts.set(key, { digest, result });
      void result.then(
        (r) => {
          this.receiptBytes += new TextEncoder().encode(
            JSON.stringify(r),
          ).length;
        },
        () => {
          this.receiptBytes += 1024;
        },
      );
      return result;
    }
    return this.run(commandId, args);
  }
  private async run(
    commandId: string,
    args: JSONValue,
    agent?: PluginGuardContext,
  ): Promise<JSONValue> {
    if (this.active) throw Error("BUSY: another extension command is running");
    const slash = commandId.indexOf("/"),
      pluginId = commandId.slice(0, slash),
      id = commandId.slice(slash + 1);
    if (slash <= 0) throw Error("Use pluginId/commandId");
    const entry = this.entry(pluginId),
      command = entry.package.manifest.commands.find((c) => c.id === id);
    if (!command) throw Error("Plugin command does not exist");
    if (!entry.enabled || this.disabledNow.has(pluginId))
      throw Error("PLUGIN_DISABLED");
    if (agent?.readOnly && !command.readOnly) throw Error("READ_ONLY");
    validateArguments(command.inputSchema, args);
    this.guard(!command.readOnly);
    if (
      !command.readOnly &&
      (this.editor.readOnly ||
        this.editor.isInteracting ||
        !this.editor.enabled)
    )
      throw Error("BUSY_OR_READ_ONLY: finish current input first");
    const processId = this.processes.get(pluginId);
    if (entry.package.manifest.runtime === "process" && !processId)
      throw Error("PROCESS_START_REQUIRED: start this extension manually");
    const runtime = processId
      ? new ProcessRuntime(this.backend, processId, this.timeoutMs)
      : this.runtimeFactory(entry.package, this.timeoutMs);
    if (processId) this.processes.delete(pluginId);
    const abort = new AbortController();
    this.active = { id: pluginId, runtime, abort };
    this.emit();
    const generation = this.generation;
    const tx: Transaction = {
      entry,
      elements: this.editor.elements,
      documentId: this.editor.document.id,
      title: this.editor.document.title,
      selection: [...this.editor.selected],
      groupScope: [...this.editor.groupScope],
      revision: this.editor.document.revision,
      page: this.editor.activePageId,
      live: true,
      writes: 0,
      label: command.title,
      commandReadOnly: !!command.readOnly,
      agent,
      data: structuredClone(entry.data),
      dataChanged: false,
    };
    const assert = (write = false) => {
      if (
        !tx.live ||
        generation !== this.generation ||
        abort.signal.aborted ||
        this.disabledNow.has(pluginId) ||
        !this.entry(pluginId).enabled
      )
        throw Error("PLUGIN_DISABLED");
      agent?.assert();
      if (write) {
        this.guard(true);
        if (tx.commandReadOnly || agent?.readOnly || this.editor.readOnly)
          throw Error("READ_ONLY");
        if (this.editor.isInteracting || !this.editor.enabled)
          throw Error("BUSY: finish current input");
        if (
          this.editor.document.id !== tx.documentId ||
          this.editor.document.revision !== tx.revision ||
          this.editor.activePageId !== tx.page ||
          JSON.stringify(this.editor.groupScope) !==
            JSON.stringify(tx.groupScope)
        )
          throw Error("REVISION_CONFLICT");
      }
    };
    let hostQueue = Promise.resolve<JSONValue>(null);
    const call: HostCall = (method, options) => {
      const result = hostQueue.then(() => {
        assert();
        return this.hostCall(tx, method, options, assert, abort.signal);
      });
      hostQueue = result.catch(() => null);
      return result;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = jsonValue(
        await Promise.race([
          runtime.invoke(id, args, call),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              abort.abort();
              runtime.stop();
              reject(Error("PLUGIN_TIMEOUT: extension was stopped"));
            }, this.timeoutMs);
          }),
        ]),
      );
      await hostQueue;
      assert(tx.writes > 0);
      if (tx.dataChanged) {
        assert();
        await this.change((entries) =>
          entries.map((e) =>
            e.package.manifest.id === pluginId ? { ...e, data: tx.data } : e,
          ),
        );
        assert(tx.writes > 0);
      }
      if (tx.writes) {
        this.editor.commit(tx.elements, tx.label);
        if (
          this.editor.elements.length !== tx.elements.length ||
          this.editor.elements.some(
            (e, i) => JSON.stringify(e) !== JSON.stringify(tx.elements[i]),
          )
        )
          throw Error("COMMIT_REJECTED");
      }
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      tx.live = false;
      abort.abort();
      runtime.stop();
      this.active = null;
      this.emit();
    }
  }
  private permission(tx: Transaction, permission: Permission) {
    if (!tx.entry.grants.permissions.includes(permission))
      throw Error("PLUGIN_PERMISSION_REQUIRED: " + permission);
  }
  private async hostCall(
    tx: Transaction,
    method: string,
    a: Record<string, JSONValue>,
    assert: (write?: boolean) => void,
    signal: AbortSignal,
  ): Promise<JSONValue> {
    jsonValue(a);
    if (method === "board.read") {
      this.permission(tx, "board:read");
      const offset = Number(a.offset ?? 0),
        limit = Number(a.limit ?? 100),
        pointOffset = Number(a.pointOffset ?? 0),
        pointLimit = Number(a.pointLimit ?? 2000);
      if (
        ![offset, limit, pointOffset, pointLimit].every(Number.isSafeInteger) ||
        offset < 0 ||
        limit < 1 ||
        limit > 200 ||
        pointOffset < 0 ||
        pointLimit < 1 ||
        pointLimit > 10000
      )
        throw Error("Invalid page or point range");
      const all = tx.elements.filter(
        (e) => !a.selectionOnly || tx.selection.includes(e.id),
      );
      const elements = all.slice(offset, offset + limit).map((e) => {
        const { dataUrl, points, ...rest } = e;
        return {
          ...rest,
          ...(dataUrl
            ? {
                asset: { embedded: true, characters: dataUrl.length },
                ...(a.includeAssets ? { dataUrl } : {}),
              }
            : {}),
          ...(points
            ? {
                pointCount: points.length,
                ...(a.includePoints
                  ? {
                      points: points.slice(
                        pointOffset,
                        pointOffset + pointLimit,
                      ),
                    }
                  : {}),
              }
            : {}),
        };
      });
      return jsonValue(
        JSON.parse(
          JSON.stringify({
            id: tx.documentId,
            revision: tx.revision,
            title: tx.title,
            pageId: tx.page ?? null,
            selection: tx.selection.slice(0, 200),
            selectionCount: tx.selection.length,
            total: all.length,
            widgetCount: all.filter((e) => e.widget).length,
            offset,
            next: offset + limit < all.length ? offset + limit : null,
            elements,
          }),
        ),
      );
    }
    if (method === "board.apply" || method === "widgets.create") {
      this.permission(tx, "board:write");
      assert(true);
      let changes = a;
      if (method === "widgets.create") {
        if (
          typeof a.type !== "string" ||
          !tx.entry.package.manifest.widgets?.some((w) => w.type === a.type) ||
          typeof a.fallback !== "string" ||
          a.fallback.length > 100000
        )
          throw Error("Invalid widget type or fallback");
        jsonValue(a.data, 256 * 1024);
        changes = {
          create: [
            {
              kind: "rectangle",
              x: a.x ?? 100,
              y: a.y ?? 100,
              width: a.width ?? 280,
              height: a.height ?? 160,
              text: a.fallback,
              fontSize: 24,
              fill: "#fff1a8",
              widget: {
                pluginId: tx.entry.package.manifest.id,
                type: a.type,
                version: 1,
                data: a.data,
                fallback: a.fallback,
              },
            },
          ],
        };
      }
      return this.stage(tx, changes, assert);
    }
    if (method.startsWith("storage.")) {
      this.permission(tx, "storage");
      if (
        typeof a.key !== "string" ||
        !/^[a-zA-Z0-9._-]{1,100}$/.test(a.key) ||
        ["__proto__", "constructor", "prototype"].includes(a.key)
      )
        throw Error("Invalid plugin storage key");
      if (method === "storage.get") return tx.data[a.key] ?? null;
      if (method === "storage.set") {
        if (tx.commandReadOnly || tx.agent?.readOnly) throw Error("READ_ONLY");
        const next = { ...tx.data, [a.key]: jsonValue(a.value) };
        jsonValue(next);
        tx.data = next;
        tx.dataChanged = true;
        return { stored: true };
      }
    }
    if (method === "network.fetch") {
      this.permission(tx, "network");
      if (tx.agent && !tx.agent.network)
        throw Error("NETWORK_PERMISSION_REQUIRED");
      if (
        typeof a.url !== "string" ||
        !tx.entry.grants.networkOrigins?.includes(networkOrigin(a.url))
      )
        throw Error("NETWORK_ORIGIN_DENIED");
      const method = a.method ?? "GET";
      if (
        !["GET", "POST"].includes(String(method)) ||
        (a.body !== undefined &&
          (typeof a.body !== "string" || a.body.length > 256000))
      )
        throw Error("Invalid network request");
      if (method !== "GET" && (tx.commandReadOnly || tx.agent?.readOnly))
        throw Error("READ_ONLY");
      const response = await fetch(a.url, {
        method: String(method),
        body: method === "POST" ? (a.body as string | undefined) : undefined,
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal,
      });
      if (!response.body) return { status: response.status, text: "" };
      const reader = response.body.getReader();
      let total = 0,
        text = "";
      const decoder = new TextDecoder();
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          total += part.value.length;
          if (total > 1024 * 1024) throw Error("Network response exceeds 1 MB");
          text += decoder.decode(part.value, { stream: true });
          assert();
        }
        text += decoder.decode();
      } finally {
        await reader.cancel().catch(() => {});
      }
      assert();
      return { status: response.status, text };
    }
    if (method === "files.read" || method === "files.write") {
      this.permission(
        tx,
        method === "files.read" ? "files:read" : "files:write",
      );
      if (tx.agent && (!tx.agent.files || !tx.agent.folder))
        throw Error("FILE_PERMISSION_REQUIRED");
      if (
        method === "files.write" &&
        (tx.commandReadOnly || tx.agent?.readOnly)
      )
        throw Error("READ_ONLY");
      if (!this.backend.file) throw Error("DESKTOP_REQUIRED");
      if (
        typeof a.path !== "string" ||
        (method === "files.write" && typeof a.data !== "string")
      )
        throw Error("Invalid file request");
      const result = await this.backend.file(
        tx.entry.package.manifest.id,
        method === "files.read" ? "read" : "write",
        a.path,
        a.data as string | undefined,
        a.overwrite === true,
        tx.agent?.folder,
      );
      assert();
      return result;
    }
    if (method === "ui.notify") {
      if (typeof a.message !== "string" || a.message.length > 1000)
        throw Error("Invalid extension notification");
      this.message = a.message;
      this.emit();
      return { shown: true };
    }
    throw Error("Unknown plugin host API: " + method);
  }
  private async stage(
    tx: Transaction,
    a: Record<string, JSONValue>,
    assert: (write?: boolean) => void,
  ): Promise<JSONValue> {
    const create = a.create ?? [],
      update = a.update ?? [],
      remove = a.delete ?? [];
    if (
      !Array.isArray(create) ||
      !Array.isArray(update) ||
      !Array.isArray(remove) ||
      create.length + update.length + remove.length + tx.writes > 500
    )
      throw Error("At most 500 board edits per command");
    if (
      a.label !== undefined &&
      (typeof a.label !== "string" || a.label.length > 200)
    )
      throw Error("Invalid undo label");
    const byId = new Map(tx.elements.map((e) => [e.id, e])),
      updated = new Map<string, SceneElement>();
    for (const raw of update) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw Error("Invalid update");
      const old = byId.get(String(raw.id)),
        patch = raw.patch;
      if (!old || !patch || typeof patch !== "object" || Array.isArray(patch))
        throw Error("Object not found or invalid patch");
      if (["id", "kind", "createdAt", "pageId"].some((k) => k in patch))
        throw Error("Object identity cannot change");
      if (
        old.locked &&
        !(Object.keys(patch).length === 1 && patch.locked === false)
      )
        throw Error("LOCKED: " + old.id);
      updated.set(old.id, {
        ...old,
        ...structuredClone(patch),
      } as SceneElement);
    }
    const deleted = new Set<string>();
    for (const id of remove) {
      if (typeof id !== "string" || !byId.has(id))
        throw Error("Object not found");
      if (byId.get(id)!.locked) throw Error("LOCKED: " + id);
      deleted.add(id);
    }
    const added = create.map((raw) => {
      if (
        !raw ||
        typeof raw !== "object" ||
        Array.isArray(raw) ||
        typeof raw.kind !== "string"
      )
        throw Error("Invalid created object");
      const e = raw as Record<string, JSONValue>,
        kind = e.kind as SceneElement["kind"];
      const el = {
        ...createElement(
          kind,
          Number(e.x ?? 100),
          Number(e.y ?? 100),
          this.editor.style,
        ),
        width: 200,
        height: 120,
        ...(["line", "arrow"].includes(kind)
          ? { endX: e.width ?? 200, endY: e.height ?? 120 }
          : {}),
        ...(kind === "stroke" ? { ink: { ...this.editor.pen } } : {}),
        ...(kind === "sticky" && this.editor.style.fill === "transparent"
          ? { fill: "#fff1a8" }
          : {}),
        ...structuredClone(e),
        id: e.id ?? uid(),
        createdAt: Date.now(),
        ...(tx.page ? { pageId: tx.page } : {}),
      } as SceneElement;
      const existingPath = el.groupPath ?? (el.groupId ? [el.groupId] : []);
      if (
        tx.groupScope.length &&
        !tx.groupScope.every((id, i) => existingPath[i] === id)
      ) {
        const path = [...tx.groupScope, ...existingPath];
        return { ...el, groupId: path[0], groupPath: path };
      }
      return el;
    });
    const next = resolveBindings([
      ...tx.elements
        .filter((e) => !deleted.has(e.id))
        .map((e) => updated.get(e.id) ?? e),
      ...added,
    ]);
    const active = new Set(this.editor.elements.map((e) => e.id));
    this.validator.validate({
      ...this.editor.document,
      schemaVersion: 5,
      pages: this.editor.pages,
      elements: [
        ...this.editor.document.elements.filter((e) => !active.has(e.id)),
        ...next,
      ],
    });
    const assets = next.filter(
      (e) => ["image", "math"].includes(e.kind) && byId.get(e.id) !== e,
    );
    if (assets.length) {
      const validate = this.editor.services.get("validate_assets");
      if (!validate) throw Error("Renderer validation is not ready");
      await validate({ elements: assets });
    }
    assert(true);
    for (const old of tx.elements.filter((e) => e.locked)) {
      const now = next.find((e) => e.id === old.id);
      if (
        !now ||
        JSON.stringify({ ...now, locked: true }) !== JSON.stringify(old)
      )
        throw Error("LOCKED: " + old.id);
    }
    validateDocument({
      ...this.editor.document,
      schemaVersion: 5,
      pages: this.editor.pages,
      elements: next,
    });
    tx.elements = next;
    tx.writes += create.length + update.length + remove.length;
    if (typeof a.label === "string") tx.label = a.label;
    return {
      created: added.map((e) => e.id),
      updated: [...updated.keys()],
      deleted: [...deleted],
    };
  }
}
