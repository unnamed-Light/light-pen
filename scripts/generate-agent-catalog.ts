import { readFile, writeFile } from "node:fs/promises";
import { tools } from "../src/agent/catalog.ts";
const path = new URL("../src/agent/catalog.json", import.meta.url);
const text = JSON.stringify({ tools }, null, 2) + "\n";
if ((await readFile(path, "utf8").catch(() => "")) !== text)
  await writeFile(path, text);
