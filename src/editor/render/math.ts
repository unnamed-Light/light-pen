import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import "mathjax-full/js/input/tex/newcommand/NewcommandConfiguration.js";

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
export function renderFormula(
  source: string,
  color = "#242424",
  fontSize = 24,
) {
  if (!source.trim()) throw new Error("Введите формулу LaTeX.");
  if (source.length > 4000)
    throw new Error("Формула должна быть короче 4000 символов.");
  // A fresh input parser keeps macros local to this formula and reproducible on reopen.
  const tex = new TeX({
    packages: ["base", "ams", "newcommand"],
    maxBuffer: 20_000,
    maxMacros: 1000,
  });
  const document = mathjax.document("", {
    InputJax: tex,
    OutputJax: new SVG({ fontCache: "none" }),
  });
  const node = document.convert(source.replace(/^\$\$?|\$\$?$/g, ""), {
    display: true,
  });
  let svg = adaptor.outerHTML(adaptor.firstChild(node) as never);
  if (svg.includes("data-mjx-error") || svg.includes("<merror"))
    throw new Error("Проверьте синтаксис формулы и названия команд.");
  const view = /viewBox="([^"]+)"/.exec(svg)?.[1].split(/\s+/).map(Number);
  if (!view || view.length !== 4 || view.some((v) => !Number.isFinite(v)))
    throw new Error("Не удалось построить формулу.");
  const width = Math.max(8, (view[2] / 1000) * fontSize),
    height = Math.max(8, (view[3] / 1000) * fontSize);
  if (width > 12000 || height > 12000)
    throw new Error(
      "Формула слишком велика. Разделите её на несколько объектов.",
    );
  svg = svg
    .replace(/width="[^"]*"/, `width="${width}"`)
    .replace(/height="[^"]*"/, `height="${height}"`)
    .replace(/currentColor/g, /^#[a-f\d]{6}$/i.test(color) ? color : "#242424");
  if (!svg.includes("xmlns="))
    svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  return {
    dataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
    width,
    height,
  };
}
