import { expect, it } from "vitest";
import { renderFormula } from "./math";
it("builds self-contained SVG for fractions, integrals and matrices", () => {
  for (const source of [
    String.raw`\frac{-b\pm\sqrt{b^2-4ac}}{2a}`,
    String.raw`\int_0^1 x^2\,dx`,
    String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
  ]) {
    const result = renderFormula(source, "#123456", 32),
      svg = decodeURIComponent(result.dataUrl.split(",")[1]);
    expect(result.width).toBeGreaterThan(10);
    expect(result.height).toBeGreaterThan(10);
    expect(svg).toContain("<path");
    expect(svg).toContain("#123456");
    expect(svg).not.toMatch(/foreignObject|<script|<image|<style|<use/);
    expect(svg).toContain("xmlns=");
  }
});
it("rejects malformed, empty, unknown and oversized formula source", () => {
  expect(() => renderFormula("")).toThrow();
  expect(() => renderFormula("x".repeat(4001))).toThrow();
  expect(() => renderFormula(String.raw`\frac{a`)).toThrow();
  expect(() => renderFormula(String.raw`\unknownCommand{x}`)).toThrow();
});
it("isolates macros between independent formulas and blocks external markup commands", () => {
  expect(() =>
    renderFormula(String.raw`\newcommand{\mycustom}{x^2}\mycustom`),
  ).not.toThrow();
  expect(() => renderFormula(String.raw`\mycustom`)).toThrow();
  expect(() =>
    renderFormula(String.raw`\href{https://example.com}{x}`),
  ).toThrow();
});
