import { backupDatabase } from "./backup.ts";
const [source, target] = process.argv.slice(2);
if (!source || !target)
  throw new Error("Укажите исходную SQLite и новый путь резервной копии.");
await backupDatabase(source, target);
console.log("Резервная копия создана и проверена.");
