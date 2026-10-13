import fs from "node:fs";
import path from "node:path";
import * as fsSafeAdvanced from "@openclaw/fs-safe/advanced";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withPluginInstallRoots } from "./install-root-context.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { withPluginSourceCaptureDirectory } from "./plugin-package-metadata-capture.js";
import {
  reclaimWarmPluginSourceCaptures,
  resolveWarmEligibleGenerationRoot,
  resolveWarmPluginSourceCapturesDirectory,
  WARM_PLUGIN_SOURCE_CAPTURE_MANIFEST,
} from "./plugin-source-capture-warm.js";

vi.mock("@openclaw/fs-safe/advanced", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/advanced")>()),
}));

const temp = useAutoCleanupTempDirTracker(afterEach);
const artifacts: ReturnType<typeof capturePluginGenerationArtifact>[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const artifact of artifacts.splice(0)) {
    artifact.dispose();
  }
});

const GENERATION_DIR_NAME = "demo__openclaw-generation__g-0123456789abcdef";

function writeFile(filename: string, content: string) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, content);
}

/** A managed npm generation: `<npm>/projects/<pkg>__openclaw-generation__g-<hash>/node_modules/demo`. */
function fixture(options: { generation?: boolean } = {}) {
  const root = fs.realpathSync(temp.make("plugin-warm-capture-"));
  const npmDir = path.join(root, "npm");
  const projects = path.join(npmDir, "projects");
  const generation = path.join(
    projects,
    options.generation === false ? "plain" : GENERATION_DIR_NAME,
  );
  const pluginRoot = path.join(generation, "node_modules", "demo");
  const entry = path.join(pluginRoot, "index.js");
  writeFile(
    path.join(pluginRoot, "package.json"),
    JSON.stringify({
      name: "demo",
      version: "1.0.0",
      type: "module",
      main: "index.js",
      dependencies: { dep: "1.0.0" },
    }),
  );
  writeFile(entry, 'import { dep } from "dep";\nexport const value = dep;\n');
  writeFile(
    path.join(generation, "node_modules", "dep", "package.json"),
    JSON.stringify({ name: "dep", version: "1.0.0", type: "module", main: "index.js" }),
  );
  writeFile(
    path.join(generation, "node_modules", "dep", "index.js"),
    'export const dep = "dep";\n',
  );
  const captures = path.join(root, "captures");
  fs.mkdirSync(captures);
  const roots = Object.freeze({
    extensionsDir: path.join(root, "extensions"),
    gitDir: path.join(root, "git"),
    npmDir,
    stateDir: root,
  });
  return {
    root,
    projects,
    generation,
    pluginRoot,
    entry,
    captures,
    warm: resolveWarmPluginSourceCapturesDirectory(captures),
    capture() {
      const artifact = withPluginInstallRoots(roots, () =>
        withPluginSourceCaptureDirectory(
          captures,
          () => capturePluginGenerationArtifact(pluginRoot, entry, (run) => run()),
          captures,
        ),
      );
      artifacts.push(artifact);
      // Pull the dependency into the capture the way a module import would.
      artifact.prepareDependency(artifact.resolve(entry), "dep");
      return artifact;
    },
    dispose(artifact: ReturnType<typeof capturePluginGenerationArtifact>) {
      artifacts.splice(artifacts.indexOf(artifact), 1);
      artifact.dispose();
    },
  };
}

function countFileCopies() {
  const createBatch = fsSafeAdvanced.createRootFileCopyBatchSync;
  const copies = vi.fn();
  vi.spyOn(fsSafeAdvanced, "createRootFileCopyBatchSync").mockImplementation(() => {
    const batch = createBatch();
    const copyFile = batch.copyFile.bind(batch);
    return {
      ...batch,
      copyFile: (options) => {
        copies(options);
        return copyFile(options);
      },
    };
  });
  return copies;
}

it("recognizes managed npm generation roots", () => {
  const generation = fixture();
  expect(
    resolveWarmEligibleGenerationRoot(generation.pluginRoot, { projectsDir: generation.projects }),
  ).toBe(generation.generation);
  const plain = fixture({ generation: false });
  expect(
    resolveWarmEligibleGenerationRoot(plain.pluginRoot, { projectsDir: plain.projects }),
  ).toBeUndefined();
  expect(
    resolveWarmEligibleGenerationRoot(generation.pluginRoot, {
      projectsDir: generation.projects,
      env: { OPENCLAW_DISABLE_WARM_PLUGIN_CAPTURES: "1" },
    }),
  ).toBeUndefined();
});

it("publishes a released generation capture and adopts it without copying again", () => {
  const demo = fixture();
  const first = demo.capture();
  const firstDigest = first.sourceDigest;
  const firstEntry = first.resolve(demo.entry);
  expect(fs.readFileSync(firstEntry, "utf8")).toContain("export const value");
  demo.dispose(first);

  const published = fs.readdirSync(demo.warm);
  expect(published).toHaveLength(1);
  const manifestPath = path.join(demo.warm, published[0]!, WARM_PLUGIN_SOURCE_CAPTURE_MANIFEST);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  expect(manifest.receipt.sourceDigest).toBe(firstDigest);
  expect(manifest.files.length).toBeGreaterThan(0);
  expect(fs.existsSync(firstEntry)).toBe(false);

  const copies = countFileCopies();
  const second = demo.capture();
  expect(second.sourceDigest).toBe(firstDigest);
  expect(fs.readFileSync(second.resolve(demo.entry), "utf8")).toContain("export const value");
  expect(fs.readdirSync(demo.warm)).toHaveLength(0);
  expect(copies).not.toHaveBeenCalled();
  demo.dispose(second);
  expect(fs.readdirSync(demo.warm)).toHaveLength(1);
});

it("fails closed when an adopted file no longer matches its recorded content", () => {
  const demo = fixture();
  demo.dispose(demo.capture());
  const published = path.join(demo.warm, fs.readdirSync(demo.warm)[0]!);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(published, WARM_PLUGIN_SOURCE_CAPTURE_MANIFEST), "utf8"),
  );
  const tampered = (manifest.files as Array<[string, unknown]>).find(([rel]) =>
    rel.endsWith(path.join("demo", "index.js")),
  );
  expect(tampered).toBeDefined();
  fs.writeFileSync(path.join(published, tampered![0]), "export const value = 'tampered';\n");
  expect(() => demo.capture()).toThrow(/Plugin source changed/);
});

it("does not adopt a capture whose generation directory was replaced", () => {
  const demo = fixture();
  demo.dispose(demo.capture());
  expect(fs.readdirSync(demo.warm)).toHaveLength(1);
  // A reinstall replaces the generation directory; same name, new identity.
  const replacement = `${demo.generation}.next`;
  fs.cpSync(demo.generation, replacement, { recursive: true });
  fs.rmSync(demo.generation, { recursive: true, force: true });
  fs.renameSync(replacement, demo.generation);
  const copies = countFileCopies();
  demo.dispose(demo.capture());
  expect(copies).toHaveBeenCalled();
});

it("keeps ordinary captures and disabled hosts on the removal path", () => {
  const plain = fixture({ generation: false });
  plain.dispose(plain.capture());
  expect(fs.existsSync(plain.warm)).toBe(false);

  vi.stubEnv("OPENCLAW_DISABLE_WARM_PLUGIN_CAPTURES", "1");
  const disabled = fixture();
  disabled.dispose(disabled.capture());
  expect(fs.existsSync(disabled.warm)).toBe(false);
});

it("reclaims warm entries whose generation is gone or whose age exceeds the limit", async () => {
  const demo = fixture();
  demo.dispose(demo.capture());
  const entry = path.join(demo.warm, fs.readdirSync(demo.warm)[0]!);
  const failures: unknown[] = [];
  await reclaimWarmPluginSourceCaptures(demo.captures, (error) => failures.push(error));
  expect(fs.existsSync(entry)).toBe(true);
  await reclaimWarmPluginSourceCaptures(
    demo.captures,
    (error) => failures.push(error),
    Date.now() + 15 * 24 * 60 * 60 * 1_000,
  );
  expect(fs.existsSync(entry)).toBe(false);

  demo.dispose(demo.capture());
  const again = path.join(demo.warm, fs.readdirSync(demo.warm)[0]!);
  fs.rmSync(demo.generation, { recursive: true, force: true });
  await reclaimWarmPluginSourceCaptures(demo.captures, (error) => failures.push(error));
  expect(fs.existsSync(again)).toBe(false);
  expect(failures).toEqual([]);
});
