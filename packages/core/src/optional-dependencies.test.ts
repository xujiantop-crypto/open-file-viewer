import { spawn } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const coreRoot = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = dirname(dirname(dirname(coreRoot)));
const require = createRequire(import.meta.url);
const cadEnginePackageName = "@mlightcad/cad-simple-viewer";
const browserSafeEmfConverterVersion = "2.0.2";

describe("optional CAD module loading", () => {
  it("bundles the built core without resolving the absent WebGL engine", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "ofv-esbuild-"));
    try {
      const fixturePackageRoot = join(fixtureRoot, "node_modules", "@open-file-viewer", "core");
      const entryPath = join(fixtureRoot, "entry.js");
      const runnerPath = join(fixtureRoot, "run-esbuild.cjs");
      const resultPath = join(fixtureRoot, "result.json");
      const esbuildPath = require.resolve("esbuild");
      const packageJson = JSON.parse(await readFile(join(coreRoot, "../package.json"), "utf8")) as {
        dependencies: Record<string, string>;
      };

      await mkdir(join(fixturePackageRoot, "dist"), { recursive: true });
      await copyFile(join(coreRoot, "../package.json"), join(fixturePackageRoot, "package.json"));
      await copyFile(join(coreRoot, "../dist/index.js"), join(fixturePackageRoot, "dist/index.js"));
      await writeFile(entryPath, 'export { cadPlugin } from "@open-file-viewer/core";\n');
      await writeFile(
        runnerPath,
        `const { build } = require(${JSON.stringify(esbuildPath)});
const [entryPath, outputPath, workspaceRoot, dependencies] = process.argv.slice(2);
build({
  absWorkingDir: workspaceRoot,
  bundle: true,
  entryPoints: [entryPath],
  external: JSON.parse(dependencies),
  format: "esm",
  logLevel: "silent",
  packages: "external",
  platform: "browser",
  plugins: [{
    name: "reject-optional-cad-resolution",
    setup(api) {
      api.onResolve({ filter: /^@mlightcad\\// }, (args) => ({
        errors: [{ text: \`Optional CAD package must not be resolved: \${args.path}\` }]
      }));
    }
  }],
  write: false
}).then((result) => require("node:fs").writeFileSync(outputPath, JSON.stringify({ code: result.outputFiles[0].text })))
  .catch((error) => { console.error(error); process.exitCode = 1; });
`
      );

      const processResult = await runNode(runnerPath, [
        entryPath,
        resultPath,
        workspaceRoot,
        JSON.stringify(Object.keys(packageJson.dependencies))
      ]);
      expect(processResult.stderr).toBe("");
      expect(processResult.exitCode).toBe(0);

      const result = JSON.parse(await readFile(resultPath, "utf8")) as { code: string };
      expect(result.code).not.toContain(`import("${cadEnginePackageName}")`);
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });
});

describe("browser-safe metafile converter dependency", () => {
  it("pins emf-converter to the audited browser-safe release", async () => {
    const packageJson = JSON.parse(await readFile(join(coreRoot, "../package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const lockfile = await readFile(join(workspaceRoot, "pnpm-lock.yaml"), "utf8");

    expect(packageJson.dependencies["emf-converter"]).toBe(browserSafeEmfConverterVersion);
    expect(lockfile).toMatch(
      /      emf-converter:\r?\n        specifier: 2\.0\.2\r?\n        version: 2\.0\.2/
    );
    expect(lockfile).toContain("  emf-converter@2.0.2: {}");
    expect(lockfile).not.toContain("emf-converter@2.0.4");
  });

  it("bundles officePlugin without resolving Node-only canvas or fs modules", async () => {
    const fixtureRoot = await mkdtemp(join(tmpdir(), "ofv-emf-esbuild-"));
    try {
      const fixtureModulesRoot = join(fixtureRoot, "node_modules");
      const fixturePackageRoot = join(fixtureModulesRoot, "@open-file-viewer", "core");
      const fixtureEmfRoot = join(fixtureModulesRoot, "emf-converter");
      const entryPath = join(fixtureRoot, "entry.js");
      const runnerPath = join(fixtureRoot, "run-esbuild.cjs");
      const resultPath = join(fixtureRoot, "result.json");
      const esbuildPath = require.resolve("esbuild");
      const emfPackageRoot = dirname(dirname(require.resolve("emf-converter")));
      const packageJson = JSON.parse(await readFile(join(coreRoot, "../package.json"), "utf8")) as {
        dependencies: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const externalDependencies = [
        ...Object.keys(packageJson.dependencies).filter((dependency) => dependency !== "emf-converter"),
        ...Object.keys(packageJson.peerDependencies || {})
      ];

      await mkdir(join(fixturePackageRoot, "dist"), { recursive: true });
      await copyFile(join(coreRoot, "../package.json"), join(fixturePackageRoot, "package.json"));
      await cp(join(coreRoot, "../dist"), join(fixturePackageRoot, "dist"), { recursive: true });
      await cp(emfPackageRoot, fixtureEmfRoot, { recursive: true });
      await writeFile(entryPath, 'export { officePlugin } from "@open-file-viewer/core";\n');
      await writeFile(
        runnerPath,
        `const { build } = require(${JSON.stringify(esbuildPath)});
const [entryPath, outputPath, workspaceRoot, dependencies] = process.argv.slice(2);
build({
  absWorkingDir: workspaceRoot,
  bundle: true,
  entryPoints: [entryPath],
  external: JSON.parse(dependencies),
  format: "esm",
  logLevel: "silent",
  platform: "browser",
  plugins: [{
    name: "reject-node-only-emf-dependencies",
    setup(api) {
      api.onResolve({ filter: /^(?:@napi-rs\\/canvas(?:\\/.*)?|node:fs|fs)$/ }, (args) => ({
        errors: [{ text: \`Browser bundle must not resolve Node-only dependency: \${args.path}\` }]
      }));
    }
  }],
  write: false
}).then((result) => require("node:fs").writeFileSync(outputPath, JSON.stringify({ code: result.outputFiles[0].text })))
  .catch((error) => { console.error(error); process.exitCode = 1; });
`
      );

      const processResult = await runNode(runnerPath, [
        entryPath,
        resultPath,
        workspaceRoot,
        JSON.stringify(externalDependencies)
      ]);
      expect(processResult.stderr).toBe("");
      expect(processResult.exitCode).toBe(0);

      const result = JSON.parse(await readFile(resultPath, "utf8")) as { code: string };
      expect(result.code).not.toContain("@napi-rs/canvas");
      expect(result.code).not.toMatch(/(?:node:fs|from ["']fs["']|require\(["']fs["']\))/);
    } finally {
      await rm(fixtureRoot, { force: true, recursive: true });
    }
  });
});

/** 在独立 Node 进程中运行 esbuild，避免 jsdom 的跨 realm typed array 破坏其启动检查。 */
function runNode(scriptPath: string, args: string[]): Promise<{ exitCode: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args]);
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (exitCode) => resolve({ exitCode, stderr }));
  });
}
