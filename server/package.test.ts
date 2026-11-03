import { test, expect } from "vitest";
import { mkdtemp, readFile, mkdir, cp, symlink, rm } from "node:fs/promises";
import { join, resolve, relative, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createDocument } from "../src/editor/model/types";
test("the Docker source file set boots independently and validates a new room without workspace-only imports", async () => {
  const workspace = resolve("."),
    root = await mkdtemp(join(tmpdir(), "lightpen-server-package-"));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const docker = await readFile("server/Dockerfile", "utf8");
    for (const line of docker
      .split(/\r?\n/)
      .filter((line) => line.startsWith("COPY "))) {
      const tokens = line
          .split(/\s+/)
          .slice(1)
          .filter((token) => !token.startsWith("--")),
        destination = tokens.at(-1)!;
      for (const source of tokens.slice(0, -1)) {
        const from = resolve(workspace, source),
          to = resolve(
            root,
            destination.replace(/^\.\//, ""),
            tokens.length > 2 || destination.endsWith("/")
              ? basename(source)
              : "",
          );
        if (
          relative(workspace, from).startsWith("..") ||
          relative(root, to).startsWith("..")
        )
          throw new Error("Package path is outside its root");
        await mkdir(dirname(to), { recursive: true });
        await cp(from, to, { recursive: true });
      }
    }
    await symlink(
      join(workspace, "node_modules"),
      join(root, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await mkdir(join(root, "data"));
    child = spawn(process.execPath, ["--import", "tsx", "server/main.ts"], {
      cwd: root,
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: "0",
        LIGHT_PEN_DATA: join(root, "data"),
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const running = child;
    const url = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("Packaged server did not start")),
        10000,
      );
      running.once("error", reject);
      running.once("exit", (code) =>
        reject(new Error("Packaged server exited: " + code)),
      );
      running.stdout!.on("data", (chunk) => {
        output += chunk.toString();
        const match = output.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) {
          clearTimeout(timer);
          resolve(match[0]);
        }
      });
    });
    expect((await fetch(url + "/health")).ok).toBe(true);
    const response = await fetch(url + "/v1/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document: createDocument("Пакетная проверка") }),
    });
    const result = await response.json();
    expect(response.status, result.error).toBe(201);
    expect(result.title).toBe("Пакетная проверка");
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise<void>((r) => child!.once("exit", () => r()));
      child.kill();
      await exited;
    }
    const target = resolve(root);
    if (
      dirname(target) !== resolve(tmpdir()) ||
      !basename(target).startsWith("lightpen-server-package-")
    )
      throw new Error("Unsafe package temporary path");
    // The dependency junction points at the real workspace; remove the link itself first.
    try {
      await rm(join(target, "node_modules"), { force: true });
    } catch (error) {
      if (process.platform !== "win32") throw error;
      await (
        await import("node:fs/promises")
      ).unlink(join(target, "node_modules"));
    }
    await rm(target, { recursive: true, force: true });
  }
}, 20000);
