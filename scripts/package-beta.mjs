import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (
  execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }).trim()
)
  throw new Error("Зафиксируйте проверенные исходники перед упаковкой беты.");
if (pkg.version.includes("-dev."))
  throw new Error(
    "Это незавершённая ветка разработки. Итоговый релиз упаковывается после выполнения docs/release-0.4-plan.md.",
  );
const output = path.join(root, "builds", pkg.version);
await mkdir(output, { recursive: true });
const files = [
  ["src-tauri/target/release/light-pen.exe", "Light Pen Beta.exe"],
  [
    `src-tauri/target/release/bundle/nsis/Light Pen_${pkg.version}_x64-setup.exe`,
    "Light Pen Beta Setup.exe",
  ],
];
const manifest = {
  product: "Light Pen",
  version: pkg.version,
  platform: "Windows x64",
  packagedAt: new Date().toISOString(),
  files: [],
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
};
for (const [source, name] of files) {
  const bytes = await readFile(path.join(root, source));
  if (bytes.subarray(0, 2).toString() !== "MZ")
    throw new Error(`Invalid Windows executable: ${source}`);
  await copyFile(path.join(root, source), path.join(output, name));
  manifest.files.push({
    name,
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
await writeFile(
  path.join(output, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);
await copyFile(
  path.join(
    root,
    `docs/test-report-${pkg.version.split(".").slice(0, 2).join(".")}.md`,
  ),
  path.join(output, "TEST-REPORT.md"),
);
await copyFile(path.join(root, "LICENSE"), path.join(output, "LICENSE.txt"));
await copyFile(
  path.join(root, "THIRD_PARTY_NOTICES.txt"),
  path.join(output, "THIRD_PARTY_NOTICES.txt"),
);
await copyFile(
  path.join(
    root,
    `docs/release-${pkg.version.split(".").slice(0, 2).join(".")}.md`,
  ),
  path.join(output, "НОВЫЕ ВОЗМОЖНОСТИ.md"),
);
await copyFile(
  path.join(root, "docs/vendor/MathJax-LICENSE.txt"),
  path.join(output, "MathJax-LICENSE.txt"),
);
for (const [source, name] of [
  ["public/fonts/OFL.txt", "NotoSans-OFL.txt"],
  ["node_modules/jspdf/LICENSE", "jsPDF-LICENSE.txt"],
  ["node_modules/svg2pdf.js/LICENSE", "svg2pdf-LICENSE.txt"],
]) {
  await copyFile(path.join(root, source), path.join(output, name));
}
await writeFile(
  path.join(output, "Начать здесь.txt"),
  "\ufeffLight Pen " +
    pkg.version +
    "\r\n\r\nLight Pen Beta.exe — запуск без установки.\r\nLight Pen Beta Setup.exe — установка приложения и регистрация файлов .lightpen.\r\nДля локальной работы не нужны Node.js, Rust или сервер разработки. Нужен системный WebView2. Для совместной работы нужен отдельно запущенный сервер; публичный сервис пока не развёрнут.\r\n\r\nP — перо, N — стикер, V — выделение. Размер стикера выбирается протягиванием по доске.\r\nQ — формула LaTeX, C — соединитель, F — фрейм. Ctrl+F — поиск, Ctrl+G — группа.\r\nКолесо — масштаб. Space + перетаскивание — перемещение. Ctrl+S — сохранить. F1 — помощь.\r\n\r\nЧерновики сохраняются автоматически. Предыдущие безымянные доски доступны через «Файл → Недавние доски».\r\nКнопка + над боковой панелью — таблицы, задачи и ссылки. F5 — презентация фреймов, Esc — выход.\r\nОписание новых функций — НОВЫЕ ВОЗМОЖНОСТИ.md. Результаты проверок и ограничения — TEST-REPORT.md.\r\n",
);
console.log(JSON.stringify(manifest, null, 2));
