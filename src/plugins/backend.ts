import { invoke, isTauri } from "@tauri-apps/api/core";
import type { PluginBackend, PluginRegistry } from "./types";
import { validateRegistry } from "./validation";
const empty = (): PluginRegistry => ({ version: 1, entries: [] });
export function defaultBackend(): PluginBackend {
  if (isTauri())
    return {
      load: async () => validateRegistry(await invoke("plugin_registry_load")),
      save: async (value) => {
        await invoke("plugin_registry_save", { value });
      },
      file: (pluginId, action, path, data, overwrite = false, agentFolder) =>
        invoke("plugin_file", {
          pluginId,
          action,
          path,
          data: data ?? null,
          overwrite,
          agentFolder: agentFolder ?? null,
        }),
      startProcess: (pluginId, acknowledgeRisk) =>
        invoke("plugin_process_start", { pluginId, acknowledgeRisk }),
      sendProcess: async (processId, message) => {
        await invoke("plugin_process_send", { processId, message });
      },
      readProcess: (processId) => invoke("plugin_process_read", { processId }),
      stopProcess: async (processId) => {
        await invoke("plugin_process_stop", { processId });
      },
    };
  return {
    load: async () =>
      validateRegistry(
        JSON.parse(
          localStorage.getItem("lightpen.plugins.v1") ??
            JSON.stringify(empty()),
        ),
      ),
    save: async (value) =>
      localStorage.setItem("lightpen.plugins.v1", JSON.stringify(value)),
  };
}
