import type {
  JSONValue,
  Permission,
  PluginManifest,
  PluginPackage,
  PluginRegistry,
  PluginSchema,
} from "./types";

export const PERMISSIONS: Permission[] = [
  "board:read",
  "board:write",
  "storage",
  "network",
  "files:read",
  "files:write",
  "process",
];
const idPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const own = (value: unknown, name: string): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`${name}: expected an object`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, name: string, max = 200) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw Error(`${name}: invalid text`);
  return value;
};
function identifier(value: unknown, name: string) {
  const id = text(value, name, 100);
  if (!idPattern.test(id))
    throw Error(`${name}: use lowercase letters, digits, dots or hyphens`);
  return id;
}
function keys(value: Record<string, unknown>, names: string[], name: string) {
  for (const key of Object.keys(value))
    if (!names.includes(key)) throw Error(`${name}.${key}: unknown field`);
}
export function jsonValue(value: unknown, maxBytes = 1024 * 1024): JSONValue {
  let count = 0;
  const visit = (v: unknown, depth: number) => {
    if (++count > 100000 || depth > 32)
      throw Error("PLUGIN_LIMIT: JSON is too complex");
    if (v === null || typeof v === "boolean" || typeof v === "string") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (Array.isArray(v)) {
      v.forEach((x) => visit(x, depth + 1));
      return;
    }
    if (
      v &&
      typeof v === "object" &&
      [Object.prototype, null].includes(Object.getPrototypeOf(v))
    ) {
      for (const [key, child] of Object.entries(v)) {
        if (["__proto__", "constructor", "prototype"].includes(key))
          throw Error("Unsafe JSON key");
        visit(child, depth + 1);
      }
      return;
    }
    throw Error("Plugin values must be JSON");
  };
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).length > maxBytes)
    throw Error("PLUGIN_LIMIT: JSON exceeds limit");
  return value as JSONValue;
}
function schema(value: unknown, depth = 0): asserts value is PluginSchema {
  if (depth > 12) throw Error("Schema exceeds 12 levels");
  const s = own(value, "schema");
  keys(
    s,
    [
      "type",
      "properties",
      "required",
      "additionalProperties",
      "items",
      "enum",
      "oneOf",
      "minimum",
      "maximum",
      "minItems",
      "maxItems",
      "maxLength",
      "description",
    ],
    "schema",
  );
  if (
    s.type !== undefined &&
    !["object", "array", "string", "number", "boolean", "null"].includes(
      String(s.type),
    )
  )
    throw Error("Unsupported schema type");
  if (s.properties !== undefined) {
    const p = own(s.properties, "schema.properties");
    if (Object.keys(p).length > 100) throw Error("Too many schema fields");
    Object.values(p).forEach((v) => schema(v, depth + 1));
  }
  if (s.items !== undefined) schema(s.items, depth + 1);
  if (s.oneOf !== undefined) {
    if (!Array.isArray(s.oneOf) || !s.oneOf.length || s.oneOf.length > 20)
      throw Error("Invalid schema alternatives");
    s.oneOf.forEach((v) => schema(v, depth + 1));
  }
  if (
    s.required !== undefined &&
    (!Array.isArray(s.required) ||
      s.required.some((v) => typeof v !== "string"))
  )
    throw Error("Invalid schema required fields");
  for (const k of ["minimum", "maximum", "minItems", "maxItems", "maxLength"])
    if (
      s[k] !== undefined &&
      (typeof s[k] !== "number" || !Number.isFinite(s[k]))
    )
      throw Error("Invalid schema limit");
  if (
    s.additionalProperties !== undefined &&
    typeof s.additionalProperties !== "boolean"
  )
    throw Error("Invalid schema additionalProperties");
  jsonValue(s, 64000);
}
export function validateArguments(s: PluginSchema | undefined, args: unknown) {
  jsonValue(args);
  const check = (s: PluginSchema, value: unknown, path: string): void => {
    if (s.oneOf) {
      let matches = 0;
      for (const choice of s.oneOf) {
        try {
          check(choice, value, path);
          matches++;
        } catch {}
      }
      if (matches !== 1)
        throw Error(path + ": expected one schema alternative");
    }
    if (
      s.enum &&
      !s.enum.some(
        (candidate) => JSON.stringify(candidate) === JSON.stringify(value),
      )
    )
      throw Error(path + ": unsupported value");
    if (s.type === "null" && value !== null)
      throw Error(path + ": expected null");
    if (
      s.type === "string" &&
      (typeof value !== "string" || value.length > (s.maxLength ?? Infinity))
    )
      throw Error(path + ": invalid text");
    if (
      s.type === "number" &&
      (typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < (s.minimum ?? -Infinity) ||
        value > (s.maximum ?? Infinity))
    )
      throw Error(path + ": invalid number");
    if (s.type === "boolean" && typeof value !== "boolean")
      throw Error(path + ": expected boolean");
    if (s.type === "array") {
      if (
        !Array.isArray(value) ||
        value.length < (s.minItems ?? 0) ||
        value.length > (s.maxItems ?? Infinity)
      )
        throw Error(path + ": invalid array");
      if (s.items) value.forEach((v, i) => check(s.items!, v, path + "." + i));
    }
    if (s.type === "object") {
      const object = own(value, path);
      for (const key of s.required ?? [])
        if (!Object.hasOwn(object, key))
          throw Error(path + "." + key + ": required");
      for (const [key, child] of Object.entries(object)) {
        if (s.properties?.[key])
          check(s.properties[key], child, path + "." + key);
        else if (s.additionalProperties === false)
          throw Error(path + "." + key + ": unknown field");
      }
    }
  };
  if (s) check(s, args, "arguments");
}
export function parsePackage(input: unknown): PluginPackage {
  if (typeof input === "string") {
    if (input.length > 2 * 1024 * 1024)
      throw Error("Plugin package exceeds 2 MB");
    input = JSON.parse(input);
  }
  jsonValue(input, 2 * 1024 * 1024);
  const p = own(input, "package");
  keys(p, ["manifest", "code"], "package");
  const m = own(p.manifest, "manifest");
  keys(
    m,
    [
      "apiVersion",
      "id",
      "name",
      "version",
      "description",
      "author",
      "runtime",
      "permissions",
      "commands",
      "panels",
      "widgets",
      "process",
    ],
    "manifest",
  );
  if (m.apiVersion !== 1) throw Error("Unsupported plugin API version");
  identifier(m.id, "manifest.id");
  text(m.name, "manifest.name", 100);
  if (
    !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(
      text(m.version, "manifest.version", 60),
    )
  )
    throw Error("Use a semantic plugin version");
  text(m.description, "manifest.description", 2000);
  if (m.author !== undefined) text(m.author, "manifest.author", 100);
  if (!["worker", "process"].includes(String(m.runtime)))
    throw Error("Unsupported plugin runtime");
  if (
    !Array.isArray(m.permissions) ||
    new Set(m.permissions).size !== m.permissions.length ||
    m.permissions.some((v) => !PERMISSIONS.includes(v as Permission))
  )
    throw Error("Unsupported or duplicate plugin permission");
  if (
    !Array.isArray(m.commands) ||
    !m.commands.length ||
    m.commands.length > 50
  )
    throw Error("A plugin needs 1–50 commands");
  const commands = new Set<string>();
  for (const c of m.commands) {
    const command = own(c, "command");
    keys(
      command,
      ["id", "title", "description", "readOnly", "inputSchema"],
      "command",
    );
    const id = identifier(command.id, "command.id");
    if (commands.has(id)) throw Error("Duplicate command ID");
    commands.add(id);
    text(command.title, "command.title", 120);
    if (command.description !== undefined)
      text(command.description, "command.description", 1000);
    if (command.readOnly !== undefined && typeof command.readOnly !== "boolean")
      throw Error("Invalid readOnly declaration");
    if (command.inputSchema !== undefined) schema(command.inputSchema);
  }
  if (m.panels !== undefined) {
    if (!Array.isArray(m.panels) || m.panels.length > 10)
      throw Error("Too many plugin panels");
    const panelIds = new Set<string>();
    for (const p of m.panels) {
      const panel = own(p, "panel");
      keys(panel, ["id", "title", "description", "command", "fields"], "panel");
      const id = identifier(panel.id, "panel.id");
      if (panelIds.has(id)) throw Error("Duplicate panel ID");
      panelIds.add(id);
      text(panel.title, "panel.title");
      if (panel.description !== undefined)
        text(panel.description, "panel.description", 1000);
      if (!commands.has(String(panel.command)))
        throw Error("Panel command does not exist");
      if (!Array.isArray(panel.fields) || panel.fields.length > 20)
        throw Error("Too many panel fields");
      const fieldIds = new Set<string>();
      for (const f of panel.fields) {
        const field = own(f, "field");
        keys(
          field,
          ["id", "label", "kind", "default", "options", "min", "max"],
          "field",
        );
        const fieldId = identifier(field.id, "field.id");
        if (fieldIds.has(fieldId)) throw Error("Duplicate panel field ID");
        fieldIds.add(fieldId);
        text(field.label, "field.label");
        if (
          !["text", "number", "boolean", "select", "color"].includes(
            String(field.kind),
          )
        )
          throw Error("Unsupported panel field");
        for (const key of ["min", "max"])
          if (
            field[key] !== undefined &&
            (typeof field[key] !== "number" || !Number.isFinite(field[key]))
          )
            throw Error("Invalid field range");
        if (
          field.options !== undefined &&
          (!Array.isArray(field.options) ||
            field.options.length > 100 ||
            field.options.some((o) => {
              const option = own(o, "option");
              return (
                typeof option.value !== "string" ||
                typeof option.label !== "string"
              );
            }))
        )
          throw Error("Invalid field options");
      }
    }
  }
  if (m.widgets !== undefined) {
    if (!Array.isArray(m.widgets) || m.widgets.length > 20)
      throw Error("Too many widget types");
    const types = new Set<string>();
    for (const w of m.widgets) {
      const widget = own(w, "widget");
      keys(widget, ["type", "title"], "widget");
      const type = identifier(widget.type, "widget.type");
      if (types.has(type)) throw Error("Duplicate widget type");
      types.add(type);
      text(widget.title, "widget.title");
    }
  }
  if (m.runtime === "worker") {
    text(p.code, "package.code", 1024 * 1024);
    if (m.process !== undefined || m.permissions.includes("process"))
      throw Error("Worker plugin cannot request process execution");
  } else {
    const process = own(m.process, "manifest.process");
    keys(process, ["executable", "args"], "process");
    text(process.executable, "process.executable", 32768);
    if (!m.permissions.includes("process"))
      throw Error("Native plugin must declare process permission");
    if (
      process.args !== undefined &&
      (!Array.isArray(process.args) ||
        process.args.length > 32 ||
        process.args.some((a) => typeof a !== "string" || a.length > 32768))
    )
      throw Error("Invalid process arguments");
    if (p.code !== undefined)
      throw Error("Native plugin cannot contain worker code");
  }
  return structuredClone(p) as unknown as PluginPackage;
}
export function validateRegistry(value: unknown): PluginRegistry {
  const r = own(value, "registry");
  if (r.version !== 1 || !Array.isArray(r.entries) || r.entries.length > 30)
    throw Error("Invalid plugin registry");
  jsonValue(r, 24 * 1024 * 1024);
  const ids = new Set<string>();
  for (const value of r.entries) {
    const entry = own(value, "entry");
    const bundle = parsePackage(entry.package);
    if (ids.has(bundle.manifest.id)) throw Error("Duplicate installed plugin");
    ids.add(bundle.manifest.id);
    if (typeof entry.enabled !== "boolean")
      throw Error("Invalid plugin enabled state");
    const grants = own(entry.grants, "grants");
    if (
      !Array.isArray(grants.permissions) ||
      grants.permissions.some(
        (p) => !bundle.manifest.permissions.includes(p as Permission),
      )
    )
      throw Error("Invalid plugin grants");
    if (grants.folder !== undefined && typeof grants.folder !== "string")
      throw Error("Invalid plugin folder");
    if (
      grants.networkOrigins !== undefined &&
      (!Array.isArray(grants.networkOrigins) ||
        grants.networkOrigins.some((o) => typeof o !== "string"))
    )
      throw Error("Invalid network origins");
    own(entry.data, "plugin data");
    jsonValue(entry.data);
  }
  return structuredClone(r) as unknown as PluginRegistry;
}
export function networkOrigin(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      ))
  )
    throw Error("Use HTTPS or a loopback address");
  return url.origin;
}
export function manifestOf(bundle: PluginPackage): PluginManifest {
  return structuredClone(bundle.manifest);
}
