/** Public SDK v1. Plugin bundles contain JavaScript compiled from JS or TypeScript. */
export type JSONValue =
  null | boolean | number | string | JSONValue[] | { [key: string]: JSONValue };
export type Permission =
  | "board:read"
  | "board:write"
  | "storage"
  | "network"
  | "files:read"
  | "files:write"
  | "process";
export interface PluginSchema {
  type?: "object" | "array" | "string" | "number" | "boolean" | "null";
  properties?: Record<string, PluginSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: PluginSchema;
  enum?: JSONValue[];
  oneOf?: PluginSchema[];
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  maxLength?: number;
  description?: string;
}
export interface PluginCommand {
  id: string;
  title: string;
  description?: string;
  readOnly?: boolean;
  inputSchema?: PluginSchema;
}
export interface PanelField {
  id: string;
  label: string;
  kind: "text" | "number" | "boolean" | "select" | "color";
  default?: JSONValue;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
}
export interface PluginPanel {
  id: string;
  title: string;
  description?: string;
  command: string;
  fields: PanelField[];
}
export interface PluginManifest {
  apiVersion: 1;
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  runtime: "worker" | "process";
  permissions: Permission[];
  commands: PluginCommand[];
  panels?: PluginPanel[];
  widgets?: { type: string; title: string }[];
  process?: { executable: string; args?: string[] };
}
export interface PluginPackage {
  manifest: PluginManifest;
  code?: string;
}
export interface PluginGrants {
  permissions: Permission[];
  folder?: string;
  networkOrigins?: string[];
}
export interface PluginEntry {
  package: PluginPackage;
  enabled: boolean;
  grants: PluginGrants;
  data: Record<string, JSONValue>;
}
export interface PluginRegistry {
  version: 1;
  entries: PluginEntry[];
}
export interface PluginBackend {
  load(): Promise<PluginRegistry>;
  save(value: PluginRegistry): Promise<void>;
  file?(
    pluginId: string,
    action: "read" | "write",
    path: string,
    data?: string,
    overwrite?: boolean,
    agentFolder?: string,
  ): Promise<JSONValue>;
  startProcess?(pluginId: string, acknowledgeRisk: boolean): Promise<string>;
  sendProcess?(processId: string, message: JSONValue): Promise<void>;
  readProcess?(processId: string): Promise<JSONValue[]>;
  stopProcess?(processId: string): Promise<void>;
}
export interface PluginGuardContext {
  session: string;
  documentId: string;
  expectedRevision: number;
  pageId?: string;
  requestId: string;
  readOnly?: boolean;
  files?: boolean;
  folder?: string;
  network?: boolean;
  assert(): void;
}
export type HostCall = (
  method: string,
  args: Record<string, JSONValue>,
) => Promise<JSONValue>;
export interface PluginRuntime {
  invoke(command: string, args: JSONValue, call: HostCall): Promise<JSONValue>;
  stop(): void;
}
export type RuntimeFactory = (
  bundle: PluginPackage,
  timeoutMs: number,
) => PluginRuntime;

/** The object available as globalThis.LightPen in an isolated plugin worker. */
export interface LightPenSDK {
  register(
    commands: Record<
      string,
      (args: JSONValue) => JSONValue | Promise<JSONValue>
    >,
  ): void;
  board: {
    read(options?: {
      selectionOnly?: boolean;
      offset?: number;
      limit?: number;
      includeAssets?: boolean;
      includePoints?: boolean;
      pointOffset?: number;
      pointLimit?: number;
    }): Promise<JSONValue>;
    apply(changes: {
      create?: Record<string, JSONValue>[];
      update?: { id: string; patch: Record<string, JSONValue> }[];
      delete?: string[];
      label?: string;
    }): Promise<JSONValue>;
  };
  widgets: {
    create(widget: {
      type: string;
      data: JSONValue;
      fallback: string;
      x?: number;
      y?: number;
      width?: number;
      height?: number;
    }): Promise<JSONValue>;
  };
  storage: {
    get(key: string): Promise<JSONValue>;
    set(key: string, value: JSONValue): Promise<JSONValue>;
  };
  network: {
    fetch(
      url: string,
      options?: { method?: "GET" | "POST"; body?: string },
    ): Promise<JSONValue>;
  };
  files: {
    read(path: string): Promise<JSONValue>;
    write(path: string, data: string, overwrite?: boolean): Promise<JSONValue>;
  };
  ui: { notify(message: string): Promise<JSONValue> };
}
