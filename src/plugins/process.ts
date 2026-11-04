import type {
  HostCall,
  JSONValue,
  PluginBackend,
  PluginRuntime,
} from "./types";
import { jsonValue } from "./validation";
/** The native process is explicitly started by the person, never by agent invoke. */
export class ProcessRuntime implements PluginRuntime {
  private stopped = false;
  constructor(
    private backend: PluginBackend,
    private processId: string,
    private timeoutMs = 8000,
  ) {}
  async invoke(
    command: string,
    args: JSONValue,
    call: HostCall,
  ): Promise<JSONValue> {
    const deadline = Date.now() + this.timeoutMs;
    await this.backend.sendProcess!(this.processId, {
      kind: "invoke",
      command,
      args,
    });
    let count = 0;
    try {
      while (!this.stopped && Date.now() < deadline) {
        const messages = await this.backend.readProcess!(this.processId);
        for (const raw of messages) {
          const message = jsonValue(raw) as Record<string, JSONValue>;
          if (message.kind === "result")
            return jsonValue(message.result ?? null);
          if (message.kind === "error") throw Error(String(message.error));
          if (
            message.kind !== "call" ||
            ++count > 100 ||
            typeof message.method !== "string" ||
            typeof message.id !== "number" ||
            !message.args ||
            typeof message.args !== "object" ||
            Array.isArray(message.args)
          )
            throw Error("Invalid native plugin response");
          try {
            const result = await call(message.method, message.args);
            await this.backend.sendProcess!(this.processId, {
              kind: "reply",
              id: message.id,
              result,
            });
          } catch (error) {
            await this.backend.sendProcess!(this.processId, {
              kind: "reply",
              id: message.id,
              error: String(
                error instanceof Error ? error.message : error,
              ).slice(0, 2000),
            });
          }
        }
      }
      throw Error(
        this.stopped
          ? "PLUGIN_DISABLED"
          : "PLUGIN_TIMEOUT: native extension stopped",
      );
    } finally {
      this.stop();
    }
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    void this.backend.stopProcess?.(this.processId).catch(() => {});
  }
}
