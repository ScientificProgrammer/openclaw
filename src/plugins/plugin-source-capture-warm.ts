import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { isMainThread } from "node:worker_threads";
import { isTruthyEnvValue } from "../infra/env.js";
import { hasErrnoCode } from "../infra/errno.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolvePluginNpmProjectsDir } from "./install-paths.js";
import { isPathInside } from "./path-safety.js";
import type { PluginRecoverySource } from "./plugin-generation-source-lookup.js";
import type { PluginCapturedSourceFact } from "./plugin-source-verification.js";

/**
 * Warm plugin source captures.
 *
 * A Gateway start captures each npm-installed plugin's package and dependency
 * tree into a private directory before executing it. Managed npm generations
 * (`<npm>/projects/<package>__openclaw-generation__g-<hash>`) are immutable:
 * a reinstall creates a new generation directory instead of editing one in
 * place. Re-copying the same immutable tree on every start is pure overhead,
 * and on small hosts with slow storage it dominates startup (see #157791).
 *
 * When such a capture is released at shutdown, it is published to
 * `<state>/tmp/plugin-captures/warm/<key>` together with a manifest of the
 * facts the capture recorded. The next start adopts the published directory
 * as retained custody: files whose recorded facts still match are not copied
 * again, and the generation receipt re-hashes every adopted file before the
 * plugin executes, so a tampered or truncated warm copy fails closed instead
 * of loading.
 */

export const WARM_PLUGIN_SOURCE_CAPTURE_DIR_NAME = "warm";
export const WARM_PLUGIN_SOURCE_CAPTURE_MANIFEST = "warm-capture.json";
const WARM_PLUGIN_SOURCE_CAPTURE_DISABLE_ENV = "OPENCLAW_DISABLE_WARM_PLUGIN_CAPTURES";
const WARM_PLUGIN_SOURCE_CAPTURE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1_000;
const WARM_PLUGIN_SOURCE_CAPTURE_VERSION = 1;
const GENERATION_PROJECT_DIR_PATTERN = /__openclaw-generation__g-[a-f0-9]{16}$/u;

export type WarmPluginSourceCaptureManifest = {
  version: typeof WARM_PLUGIN_SOURCE_CAPTURE_VERSION;
  key: string;
  generationRoot: { path: string; dev: string; ino: string };
  receipt: { signature: string; sourceDigest: string };
  /** The captured plugin root, relative to the capture directory. */
  capturedRoot: string;
  /** Original source path -> captured path relative to the capture directory. */
  sources: Array<[string, string]>;
  /** Captured path relative to the capture directory -> recorded content fact. */
  files: Array<[string, PluginCapturedSourceFact]>;
  /**
   * Symbolic links inside the capture, relative to the capture directory.
   * Adoption removes them: native admission links point into the publishing
   * process's own admission namespace, and dependency links are recreated when
   * the adopting process prepares the dependency again.
   */
  symlinks: string[];
  publishedAt: string;
};

type WarmPublisher = {
  managedRoot: string;
  manifest: () => WarmPluginSourceCaptureManifest | undefined;
};

const publishers = new Map<string, WarmPublisher>();
const log = createSubsystemLogger("plugins/warm-captures");

export function isWarmPluginSourceCaptureDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvValue(env[WARM_PLUGIN_SOURCE_CAPTURE_DISABLE_ENV]);
}

export function resolveWarmPluginSourceCapturesDirectory(managedRoot: string): string {
  return path.join(managedRoot, WARM_PLUGIN_SOURCE_CAPTURE_DIR_NAME);
}

export function resolveWarmPluginSourceCaptureKey(
  rootDir: string,
  entryFiles?: readonly string[],
): string {
  return JSON.stringify([
    path.resolve(rootDir),
    entryFiles?.map((file) => path.resolve(file)) ?? null,
  ]);
}

function warmEntryName(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}

/**
 * Returns the immutable managed npm generation project directory that owns
 * `rootDir`, or undefined when the plugin is not loaded from one.
 */
export function resolveWarmEligibleGenerationRoot(
  rootDir: string,
  options: { env?: NodeJS.ProcessEnv; projectsDir?: string } = {},
): string | undefined {
  if (isWarmPluginSourceCaptureDisabled(options.env)) {
    return undefined;
  }
  let projects: string;
  let real: string;
  try {
    projects = fs.realpathSync(options.projectsDir ?? resolvePluginNpmProjectsDir());
    real = fs.realpathSync(rootDir);
  } catch {
    return undefined;
  }
  if (!isPathInside(projects, real)) {
    return undefined;
  }
  const generation = path.join(projects, path.relative(projects, real).split(path.sep)[0] ?? "");
  if (!GENERATION_PROJECT_DIR_PATTERN.test(path.basename(generation))) {
    return undefined;
  }
  try {
    return fs.statSync(generation).isDirectory() ? generation : undefined;
  } catch {
    return undefined;
  }
}

function describeGenerationRoot(generationRoot: string) {
  const stat = fs.statSync(generationRoot, { bigint: true });
  return { path: generationRoot, dev: String(stat.dev), ino: String(stat.ino) };
}

/** The artifact owning `directory` can publish it when the capture is released. */
export function registerWarmPluginSourceCapturePublisher(
  directory: string,
  publisher: WarmPublisher,
): () => void {
  publishers.set(directory, publisher);
  return () => {
    if (publishers.get(directory) === publisher) {
      publishers.delete(directory);
    }
  };
}

function writeManifestSync(directory: string, manifest: WarmPluginSourceCaptureManifest): void {
  const target = path.join(directory, WARM_PLUGIN_SOURCE_CAPTURE_MANIFEST);
  const staging = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(staging, JSON.stringify(manifest), { mode: 0o600 });
  fs.renameSync(staging, target);
}

/**
 * Moves a released capture directory into the warm store. Returns true when the
 * directory was published and must not be removed by the caller.
 */
export function publishWarmPluginSourceCapture(directory: string): boolean {
  const publisher = publishers.get(directory);
  if (!publisher) {
    log.debug(`warm plugin source capture publication skipped: no publisher for ${directory}`);
    return false;
  }
  publishers.delete(directory);
  if (isWarmPluginSourceCaptureDisabled()) {
    return false;
  }
  let manifest: WarmPluginSourceCaptureManifest | undefined;
  try {
    manifest = publisher.manifest();
  } catch (error) {
    log.debug(`warm plugin source capture publication skipped: manifest failed: ${String(error)}`);
    return false;
  }
  if (!manifest || manifest.files.length === 0) {
    log.debug(`warm plugin source capture publication skipped: no recorded files for ${directory}`);
    return false;
  }
  const warmRoot = resolveWarmPluginSourceCapturesDirectory(publisher.managedRoot);
  const target = path.join(warmRoot, warmEntryName(manifest.key));
  try {
    fs.mkdirSync(warmRoot, { recursive: true, mode: 0o700 });
    writeManifestSync(directory, manifest);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(directory, target);
    log.info(
      `warm plugin source capture published: ${manifest.files.length} files for ${manifest.key}`,
    );
    return true;
  } catch (error) {
    // Publication is best effort: a failed move leaves the capture where the
    // caller removes it, and a stale manifest never adopts without its files.
    try {
      fs.rmSync(path.join(directory, WARM_PLUGIN_SOURCE_CAPTURE_MANIFEST), { force: true });
    } catch {
      // The caller's removal covers the leftover manifest.
    }
    process.emitWarning(`Warm plugin source capture publication skipped: ${String(error)}`);
    return false;
  }
}

/** Publishes every registered capture under `root`; the exit path removes the rest. */
export function publishWarmPluginSourceCapturesUnder(root: string): void {
  for (const directory of [...publishers.keys()]) {
    if (isPathInside(root, directory)) {
      publishWarmPluginSourceCapture(directory);
    }
  }
}

function readManifestSync(directory: string): WarmPluginSourceCaptureManifest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      fs.readFileSync(path.join(directory, WARM_PLUGIN_SOURCE_CAPTURE_MANIFEST), "utf8"),
    );
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }
  const manifest = parsed as Partial<WarmPluginSourceCaptureManifest>;
  if (
    manifest.version !== WARM_PLUGIN_SOURCE_CAPTURE_VERSION ||
    typeof manifest.key !== "string" ||
    typeof manifest.capturedRoot !== "string" ||
    !manifest.generationRoot ||
    !manifest.receipt ||
    !Array.isArray(manifest.sources) ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.symlinks)
  ) {
    return undefined;
  }
  return manifest as WarmPluginSourceCaptureManifest;
}

/**
 * Adopts a published capture for `key` when its immutable generation root is
 * unchanged. The published directory replaces the caller's fresh, empty capture
 * directory at `directory` (both live under the same managed root, so the move
 * is a rename). A missing or mismatched entry leaves the fresh directory empty.
 */
export function adoptWarmPluginSourceCapture(params: {
  managedRoot: string;
  key: string;
  generationRoot: string;
  directory: string;
}): WarmPluginSourceCaptureManifest | undefined {
  if (isWarmPluginSourceCaptureDisabled()) {
    return undefined;
  }
  const candidate = path.join(
    resolveWarmPluginSourceCapturesDirectory(params.managedRoot),
    warmEntryName(params.key),
  );
  const manifest = readManifestSync(candidate);
  if (!manifest || manifest.key !== params.key) {
    log.debug(`warm plugin source capture not found for ${params.key}`);
    return undefined;
  }
  let current: ReturnType<typeof describeGenerationRoot>;
  try {
    current = describeGenerationRoot(params.generationRoot);
  } catch {
    return undefined;
  }
  if (
    current.path !== manifest.generationRoot.path ||
    current.dev !== manifest.generationRoot.dev ||
    current.ino !== manifest.generationRoot.ino
  ) {
    log.debug(`warm plugin source capture discarded: generation changed for ${params.key}`);
    discardWarmEntrySync(candidate);
    return undefined;
  }
  try {
    // The fresh capture directory is empty; replacing it keeps its path and mode.
    fs.rmdirSync(params.directory);
    fs.renameSync(candidate, params.directory);
    fs.chmodSync(params.directory, 0o700);
  } catch (error) {
    try {
      fs.mkdirSync(params.directory, { mode: 0o700 });
    } catch (restoreError) {
      if (!hasErrnoCode(restoreError, "EEXIST")) {
        throw restoreError;
      }
    }
    if (!hasErrnoCode(error, "ENOENT")) {
      process.emitWarning(`Warm plugin source capture adoption skipped: ${String(error)}`);
    }
    return undefined;
  }
  for (const relative of manifest.symlinks) {
    const link = path.join(params.directory, relative);
    if (!isPathInside(params.directory, link)) {
      continue;
    }
    try {
      fs.unlinkSync(link);
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        process.emitWarning(`Warm plugin source capture link removal failed: ${String(error)}`);
      }
    }
  }
  try {
    fs.rmSync(path.join(params.directory, WARM_PLUGIN_SOURCE_CAPTURE_MANIFEST), { force: true });
  } catch {
    // The manifest is advisory once adopted; the receipt verifies file content.
  }
  log.info(
    `warm plugin source capture adopted: ${manifest.files.length} files for ${manifest.key} (mainThread=${isMainThread})`,
  );
  return manifest;
}

/**
 * Retained custody over an adopted directory. Only the capture directory and
 * the recorded source map are reused; forks and native recovery stay with the
 * ordinary capture path.
 */
export function createWarmPluginRecoverySource(params: {
  sourceCapture: PluginRecoverySource["sourceCapture"];
  directory: string;
  manifest: WarmPluginSourceCaptureManifest;
}): PluginRecoverySource {
  const { sourceCapture, directory, manifest } = params;
  const sources = new Map(
    manifest.sources.map(([source, captured]) => [source, path.join(directory, captured)]),
  );
  return {
    rootDir: path.join(directory, manifest.capturedRoot),
    sourceCapture,
    resolve: (source: string) => {
      const captured = sources.get(path.resolve(source));
      if (!captured) {
        throw new Error("Plugin recovery entry is outside its captured source package");
      }
      return captured;
    },
    fork: () => {
      throw new Error("Warm plugin source captures do not fork");
    },
    dispose: () => sourceCapture.dispose(),
    disposeAsync: () => sourceCapture.disposeAsync(),
  };
}

function discardWarmEntrySync(directory: string): void {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Reclamation retries on the next sweep.
  }
}

/** Builds the manifest for a capture that the next start may adopt. */
export function createWarmPluginSourceCaptureManifest(params: {
  key: string;
  generationRoot: string;
  receipt: { signature: string; sourceDigest: string };
  directory: string;
  capturedRoot: string;
  capturedPaths: ReadonlyMap<string, string>;
  files: ReadonlyMap<string, PluginCapturedSourceFact>;
}): WarmPluginSourceCaptureManifest | undefined {
  if (!isPathInside(params.directory, params.capturedRoot)) {
    return undefined;
  }
  const sources: Array<[string, string]> = [];
  for (const [source, captured] of params.capturedPaths) {
    if (source !== captured && isPathInside(params.directory, captured)) {
      sources.push([source, path.relative(params.directory, captured)]);
    }
  }
  return {
    version: WARM_PLUGIN_SOURCE_CAPTURE_VERSION,
    key: params.key,
    generationRoot: describeGenerationRoot(params.generationRoot),
    receipt: { ...params.receipt },
    capturedRoot: path.relative(params.directory, params.capturedRoot),
    sources,
    files: [...params.files],
    symlinks: listSymbolicLinksSync(params.directory),
    publishedAt: new Date().toISOString(),
  };
}

function listSymbolicLinksSync(directory: string): string[] {
  const links: string[] = [];
  for (const entry of fs.readdirSync(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      links.push(path.relative(directory, path.join(entry.parentPath, entry.name)));
    }
  }
  return links;
}

/** Removes warm entries whose generation root is gone or whose age exceeds the limit. */
export async function reclaimWarmPluginSourceCaptures(
  managedRoot: string,
  recordFailure: (error: unknown) => void,
  now = Date.now(),
): Promise<void> {
  const warmRoot = resolveWarmPluginSourceCapturesDirectory(managedRoot);
  let entries: fs.Dirent[];
  try {
    entries = await fsPromises.readdir(warmRoot, { withFileTypes: true });
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      recordFailure(error);
    }
    return;
  }
  for (const entry of entries) {
    const directory = path.join(warmRoot, entry.name);
    try {
      if (!entry.isDirectory()) {
        await fsPromises.rm(directory, { force: true });
        continue;
      }
      const manifest = readManifestSync(directory);
      const stale =
        !manifest ||
        now - Date.parse(manifest.publishedAt) > WARM_PLUGIN_SOURCE_CAPTURE_MAX_AGE_MS ||
        !fs.existsSync(manifest.generationRoot.path);
      if (stale) {
        await fsPromises.rm(directory, { recursive: true, force: true });
      }
    } catch (error) {
      if (!hasErrnoCode(error, "ENOENT")) {
        recordFailure(error);
      }
    }
  }
}
