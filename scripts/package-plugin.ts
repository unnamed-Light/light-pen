import { readFile, writeFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
import ts from "typescript";
import { parsePackage } from "../src/plugins/validation";

async function pack(manifestPath: string, codePath: string, output: string) {
  const input = JSON.parse(await readFile(manifestPath, "utf8"));
  let code = (await readFile(codePath, "utf8")).replace(/\r\n/g, "\n");
  if (extname(codePath) === ".ts") {
    const source = ts.createSourceFile(
      codePath,
      code,
      ts.ScriptTarget.ES2022,
      true,
    );
    if (
      source.statements.some(
        (s) =>
          ts.isImportDeclaration(s) ||
          ts.isExportDeclaration(s) ||
          ts.isExportAssignment(s) ||
          ts
            .getModifiers(s as ts.HasModifiers)
            ?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
      )
    )
      throw Error(
        "Плагин должен быть одним скриптом без import/export. Сначала объедините зависимости в IIFE. Для типов используйте plugins/sdk.d.ts.",
      );
    const compiled = ts.transpileModule(code, {
      fileName: codePath,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
      reportDiagnostics: true,
    });
    const errors =
      compiled.diagnostics?.filter(
        (d) => d.category === ts.DiagnosticCategory.Error,
      ) ?? [];
    if (errors.length)
      throw Error(
        ts.formatDiagnosticsWithColorAndContext(errors, {
          getCanonicalFileName: (f) => f,
          getCurrentDirectory: () => process.cwd(),
          getNewLine: () => "\n",
        }),
      );
    code = compiled.outputText;
  }
  const bundle = parsePackage({ manifest: input.manifest ?? input, code });
  await writeFile(output, JSON.stringify(bundle, null, 2) + "\n");
}
const args = process.argv.slice(2);
if (args.length === 0) {
  await pack(
    "plugins/examples/ideas.lightpen-plugin",
    "plugins/examples/ideas.js",
    "plugins/examples/ideas.lightpen-plugin",
  );
  const target = "plugins/examples/native-stamp.lightpen-plugin",
    native = JSON.parse(await readFile(target, "utf8"));
  native.manifest.process.args = [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    (await readFile("plugins/examples/native-stamp.ps1", "utf8")).replace(
      /\r\n/g,
      "\n",
    ),
  ];
  await writeFile(target, JSON.stringify(parsePackage(native), null, 2) + "\n");
  console.log("Примеры плагинов собраны.");
} else {
  if (args.length !== 3)
    throw Error(
      "Использование: npm run plugin:pack -- manifest.json code.ts output.lightpen-plugin",
    );
  await pack(resolve(args[0]), resolve(args[1]), resolve(args[2]));
  console.log("Пакет плагина создан: " + resolve(args[2]));
}
