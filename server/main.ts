import { resolve } from "node:path";
import { createCollaborationServer } from "./server.ts";
const port = Number(process.env.PORT ?? 8787),
  host = process.env.HOST ?? "127.0.0.1";
const app = createCollaborationServer({
  database: resolve(
    process.env.LIGHT_PEN_DATA ?? "server-data",
    "collaboration.sqlite",
  ),
  origins: process.env.LIGHT_PEN_ORIGINS?.split(","),
  allowRegistration: process.env.LIGHT_PEN_REGISTRATION !== "closed",
  trustProxy: process.env.LIGHT_PEN_TRUST_PROXY === "true",
  maxTotalBytes: Number(process.env.LIGHT_PEN_MAX_BYTES ?? 1024 * 1024 * 1024),
});
console.log("Light Pen collaboration: " + (await app.listen(port, host)));
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void app.close().then(() => process.exit(0));
  });
