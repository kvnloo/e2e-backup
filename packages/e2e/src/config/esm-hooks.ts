/**
 * e2e's TypeScript loader: synchronous module customization hooks
 * (`module.registerHooks`) that run config, test, and helper TypeScript and
 * JSX on Node.js, for `import` and `require` alike. `compiled-files.ts` says
 * which files it compiles and which tsconfig.json governs them.
 *
 * Resolve: an import written in a compiled file follows TypeScript's rules;
 * every other import, JavaScript's included, resolves as Node.js resolves it.
 * - A relative or absolute path: `./x.js` names the first of `x.ts`,
 *   `x.tsx`, `x.js`, and `x.jsx` that exists (`./x.jsx` tries `x.tsx`, `x.ts`,
 *   `x.jsx`, `x.js`; `./x.mjs` names `x.mts`, `./x.cjs` names `x.cts`), an
 *   extensionless `./x` names `x.ts`, `x.tsx`, `x.js`, `x.jsx`, or `x.json`,
 *   and a directory names its index the same way.
 * - A bare specifier the project's tsconfig.json maps through `paths` or
 *   `baseUrl` names the mapped file, before any package of that name.
 * - A `#` import or package subpath whose target is not a file names the
 *   TypeScript file behind it, for an `import`: `x.ts` for a missing `./x.js`
 *   (or `.jsx`, `.mjs`, `.cjs`) or `./x`, and for a directory (one a map
 *   names, or a subpath of a package without `exports`) its `main` or index.
 *
 * Format: `.ts`, `.mts`, `.tsx`, and `.jsx` are ES modules wherever they are
 * and whatever the nearest package.json says, so a Next.js app, or any
 * package without `"type": "module"`, keeps its module type and still runs
 * its TypeScript tests, whether it is imported or a CommonJS file requires it;
 * `.cts` is CommonJS. A JSON file imported without `with { type: 'json' }`
 * loads as a module whose default export is the parsed file.
 *
 * Freshness: a module the loader puts in a fresh graph hands its graph key
 * on to every file it reaches by path or `#` import outside `node_modules`,
 * so the project's own graph (a config and the base config or targets file
 * it imports) evaluates afresh with it, while packages stay one shared
 * instance. The graph's tsconfig.json and file lookups are its own too
 * (`tsconfig.ts`).
 *
 * Registrars: a project file that registered a test or a hook while it
 * evaluated (`registrar-modules.ts`), and every project file that imports
 * it, evaluates again with each fresh load that reaches it, by taking the
 * importer's load key. A test file imported again then gets the tests and
 * hooks of the helper it imports again, where one shared instance of the
 * helper would register them for its first importer alone. The load that
 * first reached a file keeps the one instance it evaluated. `require()` has
 * no query, so a CommonJS registrar stays one instance.
 *
 * Bun runs none of this: it compiles TypeScript and resolves the project's
 * imports itself, and `bun-loader.ts` keeps its loads fresh.
 *
 * This module, and everything it imports from e2e, is loaded by Node.js's
 * own type stripping when a worker runs from source (`register.ts`), so it
 * holds to erasable TypeScript: no enums, namespaces, or parameter
 * properties.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import nodeModule, { type LoadHookSync, type ResolveHookContext, type ResolveHookSync } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { InfrastructureError } from '@e2e-dev/core/lib/internal/errors';
import { onBun, unsupportedRuntimeMessage } from '../internal/runtime.ts';
import { realmSlot } from '@e2e-dev/core/lib/internal/realm-slot';
import { originalModuleURLSlot, registrarModuleSlot } from '../internal/registrar-modules.ts';
import { compiledSource, HOOKED_REQUIRE_KEY, IMPLIED_EXTENSIONS, isProjectFile, writtenCandidates, type CompiledSource } from './compiled-files.ts';
import { isPathSpecifier, pathTarget, type Target } from './specifiers.ts';
import { projectView, ProjectView } from './tsconfig.ts';
import { compileTypeScript } from './typescript.ts';

type Resolution = ReturnType<ResolveHookSync>;
type NextResolve = Parameters<ResolveHookSync>[2];

/** A URL scheme other than `file:` (`node:`, `data:`, `https:`); never a tsconfig alias. */
const URL_SCHEME = /^[a-z][\d+.a-z-]*:/i;
/** The query parameter a fresh module graph carries on every project file. */
const GRAPH_PARAM = 'e2e-graph';
/** The query parameter a fresh load carries: the key of the load. */
const FRESH_PARAM = 'e2e';
/** The project files that import each project file, by path. */
const importers = new Map<string, Set<string>>();
/** The registrars and the files that import them, by path; see "Registrars" above. */
const registrars = new Set<string>();
/**
 * The fresh load that first reached each project file, by path. That load
 * evaluated the file without a query, so it keeps that instance when the
 * file turns out to be a registrar while the load is still importing.
 */
const firstLoads = new Map<string, string>();
/**
 * The key of the fresh load at work: the one importing its module, or the
 * one whose module's code runs (a test or a hook of the file it imported).
 * A file that carries no query is one instance for every load, so an import
 * it makes (a function of it that a test file or a test calls, say) belongs
 * to the load at work, not to the load that first reached the file.
 */
interface ActiveLoad {
  readonly key: string;
  readonly entryURL?: string;
}

/** The original URL and the freshness keys actually added by the loader. */
interface ModuleLoad {
  readonly originalURL: string | undefined;
  readonly key: string | undefined;
  readonly graph: string | undefined;
}

interface FreshnessState {
  readonly atWork: AsyncLocalStorage<ActiveLoad>;
  readonly moduleLoads: Map<string, ModuleLoad>;
  sequence: number;
}

/** The process installs one resolver, but any installed copy can start a load. */
const freshnessSlot = realmSlot<FreshnessState>('e2e.typescript-loader-freshness.v1');
const freshness = freshnessSlot.get(globalThis) ?? {
  atWork: new AsyncLocalStorage<ActiveLoad>(),
  moduleLoads: new Map<string, ModuleLoad>(),
  sequence: 0,
};
freshnessSlot.set(globalThis, freshness);
const { atWork, moduleLoads } = freshness;

/** A sequence shared by every copy using the process loader. */
export function nextFreshLoadSequence(): number {
  freshness.sequence += 1;
  return freshness.sequence;
}

/** Runs `work` as part of the fresh load `key`: the import of its module, or code of that module. */
export function runInLoad<T>(key: string, work: () => T): T {
  return atWork.run({ key }, work);
}

/** Makes `file`, and every project file that reaches it by import, a registrar. */
function addRegistrar(file: string): void {
  if (registrars.has(file)) return;
  registrars.add(file);
  for (const importer of importers.get(file) ?? []) addRegistrar(importer);
}

/**
 * The resolution of an import written in a project file, noted as an edge
 * of the import graph and, for a registrar imported from a fresh load,
 * moved into that load.
 */
function inFreshLoad(parentURL: string | undefined, resolution: Resolution, key: string | undefined): Resolution {
  if (parentURL?.startsWith('file:') !== true || !resolution.url.startsWith('file:')) return resolution;
  const parent = new URL(parentURL);
  const child = new URL(resolution.url);
  if (!isProjectFile(parent) || !isProjectFile(child)) return resolution;
  const [parentFile, childFile] = [fileURLToPath(parent), fileURLToPath(child)];
  let known = importers.get(childFile);
  if (known === undefined) importers.set(childFile, (known = new Set()));
  known.add(parentFile);
  if (registrars.has(childFile)) addRegistrar(parentFile);
  if (key === undefined) return resolution;
  if (!firstLoads.has(childFile)) firstLoads.set(childFile, key);
  // An existing query parameter is user data. Preserve it in the resolved URL.
  if (!registrars.has(childFile) || firstLoads.get(childFile) === key || child.searchParams.has(FRESH_PARAM)) return resolution;
  return { ...resolution, url: appendQuery(child, FRESH_PARAM, key) };
}

/** Adds a loader query parameter without re-encoding any user query or fragment. */
function appendQuery(url: URL, name: string, value: string): string {
  const fragment = url.href.indexOf('#');
  const end = fragment === -1 ? url.href.length : fragment;
  const beforeHash = url.href.slice(0, end);
  const separator = beforeHash.includes('?') ? '&' : '?';
  return `${beforeHash}${separator}${new URLSearchParams([[name, value]])}${url.href.slice(end)}`;
}

/**
 * How a specifier reaches its file: by path (a relative or absolute path, a
 * `file:` URL, a tsconfig alias the loader mapped to a file), through the
 * importing package's own `#` imports, or by a package name.
 */
type Reach = 'path' | 'own-imports' | 'package';

/** How `specifier`, as written, reaches its file. */
function reach(specifier: string): Reach {
  if (isPathSpecifier(specifier, false)) return 'path';
  return specifier.startsWith('#') ? 'own-imports' : 'package';
}

/**
 * Makes the URL to evaluate `absolutePath` afresh under `key`; with `graph`,
 * every project file it imports by path or `#` import is fresh too, shared
 * with every other module loaded under the same `graph`.
 */
export function freshModuleURL(absolutePath: string, key: string, graph: string | undefined): string {
  const url = pathToFileURL(absolutePath);
  url.searchParams.set(FRESH_PARAM, key);
  if (graph !== undefined) url.searchParams.set(GRAPH_PARAM, graph);
  // The resolve hook records the original URL after Node resolves symlinks.
  moduleLoads.set(url.href, { originalURL: undefined, key, graph });
  return url.href;
}

/** Evaluates the entry URL as part of its fresh load. */
export function importFreshModule(absolutePath: string, key: string, graph: string | undefined): Promise<unknown> {
  const entryURL = freshModuleURL(absolutePath, key, graph);
  return atWork.run({ key, entryURL }, () => import(entryURL));
}

/** The first of `candidates` that is a file. */
function firstFile(candidates: readonly string[], view: ProjectView): string | undefined {
  return candidates.find((candidate) => view.isFile(candidate));
}

/** The TypeScript file behind `target`'s written extension (`x.ts` for `x.js`), or the file as written. */
function swappedFile(target: string, view: ProjectView): string | undefined {
  const extension = path.extname(target);
  const stem = target.slice(0, target.length - extension.length);
  return firstFile(writtenCandidates(extension).map((candidate) => `${stem}${candidate}`), view);
}

/** The `main` a directory's package.json names, as a path, or undefined. */
function directoryMain(directory: string, view: ProjectView): string | undefined {
  const manifest = path.join(directory, 'package.json');
  if (!view.isFile(manifest)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifest, 'utf8'));
  } catch {
    return undefined;
  }
  const main = typeof parsed === 'object' && parsed !== null && 'main' in parsed ? parsed.main : undefined;
  return typeof main === 'string' && main !== '' ? path.resolve(directory, main) : undefined;
}

/**
 * The file an import of the path `target` names under TypeScript's rules:
 * the TypeScript file behind a written extension, the file itself, the file
 * an extensionless path leaves out, or for a directory the file its
 * package.json `main` names, else its index.
 */
function typeScriptFile(target: string, view: ProjectView): string | undefined {
  if (writtenCandidates(path.extname(target)).length > 0) return swappedFile(target, view);
  if (view.isFile(target)) return target;
  const implied = firstFile(IMPLIED_EXTENSIONS.map((extension) => `${target}${extension}`), view);
  if (implied !== undefined) return implied;
  const main = directoryMain(target, view);
  const fromMain = main === undefined || main === target ? undefined : typeScriptFile(main, view);
  return fromMain ?? firstFile(IMPLIED_EXTENSIONS.map((extension) => `${path.join(target, 'index')}${extension}`), view);
}

/**
 * The file an import written in `importer` names under TypeScript's rules,
 * when that is not what Node.js would resolve: a path (`./x.js`, `./x`,
 * `./dir`), or a bare specifier the project's tsconfig maps.
 */
function typeScriptTarget(specifier: string, importer: CompiledSource, requiring: boolean, view: ProjectView): Target | undefined {
  const byPath = pathTarget(specifier, importer.file, requiring);
  if (byPath !== undefined) {
    const file = typeScriptFile(byPath.file, view);
    return file === undefined || file === byPath.file ? undefined : { file, suffix: byPath.suffix };
  }
  if (!importer.project || specifier.startsWith('#') || URL_SCHEME.test(specifier) || nodeModule.isBuiltin(specifier)) return undefined;
  for (const candidate of view.tsconfigFor(importer.file)?.paths?.(specifier) ?? []) {
    const file = typeScriptFile(candidate, view);
    if (file !== undefined) return { file, suffix: '' };
  }
  return undefined;
}

/**
 * The project file the bare `specifier`, imported in `file`, names through
 * the tsconfig.json `paths` or `baseUrl` that governs `file`, as the resolve
 * hook finds it; undefined for a specifier the hook leaves to Node.js, which
 * names a package.
 */
export function aliasedFile(specifier: string, file: string): string | undefined {
  const importer = compiledSource(pathToFileURL(file).href);
  if (importer === undefined || isPathSpecifier(specifier, false)) return undefined;
  return typeScriptTarget(specifier, importer, false, new ProjectView(false))?.file;
}

/** Whether `context` is a `require()`, whose resolver takes paths where `import` takes `file:` URLs. */
function requires(context: Pick<ResolveHookContext, 'conditions'>): boolean {
  return context.conditions.includes('require');
}

/** `target` as a specifier the resolver behind `context` accepts. */
function targetSpecifier(target: Target, context: ResolveHookContext): string {
  return requires(context) ? target.file : `${pathToFileURL(target.file).href}${target.suffix}`;
}

/** The resolution, with a compiled file's format set to the one the loader compiles it for. */
function withFormat(resolution: Resolution): Resolution {
  const format = compiledSource(resolution.url)?.kind.format;
  return format === undefined || resolution.format === format ? resolution : { ...resolution, format };
}

/**
 * The resolution, joined to its importer's fresh graph: a project file
 * reached by path or by a `#` import from a module in a fresh graph
 * joins that graph. A package reached by name keeps its shared
 * instance, even a workspace package that resolves outside `node_modules`: a
 * second instance of it would import a second instance of e2e itself.
 */
function inGraph(how: Reach, graph: string | null, resolution: Resolution): Resolution {
  if (graph === null || how === 'package' || !resolution.url.startsWith('file:')) return resolution;
  const file = new URL(resolution.url);
  if (!isProjectFile(file) || file.searchParams.has(GRAPH_PARAM)) return resolution;
  return { ...resolution, url: appendQuery(file, GRAPH_PARAM, graph) };
}

/** The file TypeScript's rules find for `missing`, a target URL that is not on disk, as a URL with the target's query and hash. */
function typeScriptFileFor(missing: URL, view: ProjectView): string | undefined {
  const target = fileURLToPath(missing);
  const file = typeScriptFile(target, view);
  // The file keeps the target's query and hash, which are part of its module identity.
  return file === undefined || file === target ? undefined : `${pathToFileURL(file).href}${missing.search}${missing.hash}`;
}

/**
 * The codes Node.js throws for an `import` whose target is not a file: a
 * missing one, or a directory (an ES module never loads a directory's index).
 */
const UNRESOLVED_TARGET: ReadonlySet<unknown> = new Set(['ERR_MODULE_NOT_FOUND', 'ERR_UNSUPPORTED_DIR_IMPORT']);

/**
 * The resolution of `request`, a `#` import or package subpath written in a
 * compiled file, moved to the file TypeScript's rules find when the target
 * is not a file (`x.ts` for a mapped `./x.js` or `./x`, a directory's index,
 * whether a map names the directory or a package without `exports` has it).
 * Node.js throws for such a target, naming it on the error of an `import`
 * (not of a `require()`). Yarn PnP's resolver returns a `#` target anyway,
 * to fail when it loads; for a package subpath it throws without naming the
 * target, so that import still fails.
 */
function resolveExport(request: string, context: ResolveHookContext, nextResolve: NextResolve, view: ProjectView): Resolution {
  let resolution: Resolution;
  try {
    resolution = nextResolve(request, context);
  } catch (error) {
    const { code, url } = error as { code?: unknown; url?: unknown };
    const file = UNRESOLVED_TARGET.has(code) && typeof url === 'string' && url.startsWith('file:') ? typeScriptFileFor(new URL(url), view) : undefined;
    if (file === undefined) throw error;
    return nextResolve(file, context);
  }
  if (!resolution.url.startsWith('file:')) return resolution;
  const target = new URL(resolution.url);
  const file = view.isFile(fileURLToPath(target)) ? undefined : typeScriptFileFor(target, view);
  return file === undefined ? resolution : nextResolve(requires(context) ? fileURLToPath(file) : file, context);
}

const legacyConfigParents = new Map<string, boolean>();

/** Older openHost callers import the config directly from their own loader. */
function isConfigLoader(parentURL: string | undefined): boolean {
  if (parentURL?.startsWith('file:') !== true || !/\/(?:dist\/config\/load\.js|src\/config\/load\.ts)$/.test(parentURL)) return false;
  const known = legacyConfigParents.get(parentURL);
  if (known !== undefined) return known;
  let isE2E = false;
  try {
    const manifestPath = path.resolve(fileURLToPath(parentURL), '../../../package.json');
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    isE2E = typeof manifest === 'object' && manifest !== null && 'name' in manifest && manifest.name === 'e2e';
  } catch {
    // An unidentifiable importer cannot start a legacy config graph.
  }
  legacyConfigParents.set(parentURL, isE2E);
  return isE2E;
}

/** Recognizes the old graph:true config entry, only at its direct import. */
function legacyConfigEntry(specifier: string, parentURL: string | undefined, url: string): ModuleLoad | undefined {
  if (!specifier.startsWith('file:') || !url.startsWith('file:') || moduleLoads.has(url)) return undefined;
  const queryAt = specifier.indexOf('?');
  if (queryAt === -1) return undefined;
  const query = specifier.slice(queryAt);
  const key = /^\?e2e=(module-[1-9]\d*)&e2e-graph=\1$/.exec(query)?.[1];
  if (key === undefined || new URL(url).search !== query || !isConfigLoader(parentURL)) return undefined;
  return { originalURL: undefined, key, graph: key };
}

/** A later resolver can append a fragment after this loader records the URL. */
function graphOf(url: string | undefined, known: ModuleLoad | undefined): string | null {
  if (known !== undefined || url === undefined) return known?.graph ?? null;
  const fragment = url.indexOf('#');
  if (fragment === -1) return null;
  // Only config graph lookups can use the fragmentless URL.
  return moduleLoads.get(url.slice(0, fragment))?.graph ?? null;
}

export const resolve: ResolveHookSync = (specifier, context, nextResolve) => {
  const importer = compiledSource(context.parentURL);
  const parentLoad = context.parentURL === undefined ? undefined : moduleLoads.get(context.parentURL);
  const graph = graphOf(context.parentURL, parentLoad);
  // Only an import written in a compiled file looks at the project's files.
  const view = importer === undefined ? undefined : projectView(graph);
  const target = importer === undefined || view === undefined ? undefined : typeScriptTarget(specifier, importer, requires(context), view);
  const how: Reach = target === undefined ? reach(specifier) : 'path';
  const request = target === undefined ? specifier : targetSpecifier(target, context);
  const resolution = withFormat(
    view !== undefined && how !== 'path' ? resolveExport(request, context, nextResolve, view) : nextResolve(request, context),
  );
  // CommonJS caches modules by file, with no query to make one fresh.
  if (requires(context)) return resolution;
  const active = atWork.getStore();
  const key = parentLoad?.key ?? active?.key;
  const inFreshGraph = inGraph(how, graph, resolution);
  const fresh = inFreshLoad(context.parentURL, inFreshGraph, key);
  const entry = specifier === active?.entryURL
    ? moduleLoads.get(specifier)
    : legacyConfigEntry(specifier, context.parentURL, resolution.url);
  if (entry !== undefined && resolution.url.startsWith('file:')) {
    // Use the resolved path after Node has applied its symlink rules.
    moduleLoads.set(fresh.url, { ...entry, originalURL: resolution.url.split('?', 1)[0]! });
  } else if (fresh.url !== resolution.url) {
    moduleLoads.set(fresh.url, {
      originalURL: resolution.url,
      key: fresh !== inFreshGraph ? key : undefined,
      graph: inFreshGraph !== resolution ? graph ?? undefined : undefined,
    });
  }
  return fresh;
};

export const load: LoadHookSync = (url, context, nextLoad) => {
  const source = compiledSource(url);
  if (source !== undefined) {
    const { format } = source.kind;
    const loaded = nextLoad(url, { ...context, format });
    const compilerOptions = source.project
      ? (projectView(graphOf(url, moduleLoads.get(url))).tsconfigFor(source.file)?.compilerOptions ?? {})
      : {};
    return { format, source: compileTypeScript(source.file, text(loaded.source, source.file), source.kind, compilerOptions), shortCircuit: true };
  }
  // A require() has no import attributes, whatever the hook types say.
  if (url.startsWith('file:') && path.extname(new URL(url).pathname) === '.json' && !requires(context) && context.importAttributes?.type === undefined) {
    const loaded = nextLoad(url, { ...context, format: 'json', importAttributes: { ...context.importAttributes, type: 'json' } });
    return { format: 'module', source: `export default JSON.parse(${JSON.stringify(text(loaded.source, fileURLToPath(url)))});\n`, shortCircuit: true };
  }
  return nextLoad(url, context);
};

/**
 * Module source as text, a byte order mark dropped, whichever form the next
 * hook returned it in. A hook may hand CommonJS on with no source at all,
 * for Node.js's CommonJS loader to read (Yarn PnP's does); the loader reads
 * the file itself then, as that loader would.
 */
function text(source: ReturnType<LoadHookSync>['source'], file: string): string {
  if (source === undefined || source === null) return readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return typeof source === 'string' ? source.replace(/^\uFEFF/, '') : new TextDecoder().decode(source);
}

/**
 * `require` for the CommonJS module at `filename`, for compiled CommonJS on
 * a Node.js whose `require` in a CommonJS module an ES module imported skips
 * resolve hooks (`typescript.ts`). Its `resolve` runs this module's resolve
 * hook itself: before nodejs/node#62028 (24.15.0; not in Node.js 22),
 * `require.resolve` skips module hooks even on a `require` from
 * `module.createRequire`.
 */
function hookedRequire(filename: string): NodeJS.Require {
  const base = nodeModule.createRequire(filename);
  const parentURL = pathToFileURL(filename).href;
  const resolveRequest = (request: string, options?: { paths?: string[] }): string => {
    const { url } = resolve(request, { conditions: ['require', 'node'], importAttributes: {}, parentURL }, (next) => {
      const resolved = base.resolve(next, options);
      return { url: nodeModule.isBuiltin(resolved) ? resolved : pathToFileURL(resolved).href };
    });
    return url.startsWith('file:') ? fileURLToPath(url) : url;
  };
  const hooked = ((request: string): unknown => base(request)) as NodeJS.Require;
  return Object.assign(hooked, base, { resolve: Object.assign(resolveRequest, { paths: base.resolve.paths }) });
}

/** Marks the process whose module loader is ready, whichever copy of e2e readied it: these hooks registered, or Bun checked. */
const registration = realmSlot<true>('e2e.typescript-loader.v1');
/** Where compiled CommonJS finds `hookedRequire`. */
const hookedRequireSlot = realmSlot<(filename: string) => NodeJS.Require>(HOOKED_REQUIRE_KEY);

/**
 * Registers the hooks once per process, and has stack traces follow the
 * source maps the compiled files carry. Refuses a runtime the loader cannot
 * rely on (`runtime.ts`). Bun gets no hooks: it compiles the project's
 * TypeScript itself (`bun-loader.ts`).
 */
export function registerLoader(): void {
  if (registration.get(globalThis) === true) return;
  const unsupported = unsupportedRuntimeMessage();
  if (unsupported !== undefined) throw new InfrastructureError('NODE_UNSUPPORTED', unsupported);
  if (!onBun) {
    nodeModule.registerHooks({ resolve, load });
    registrarModuleSlot.set(globalThis, addRegistrar);
    originalModuleURLSlot.set(globalThis, (url) => moduleLoads.get(url)?.originalURL);
    hookedRequireSlot.set(globalThis, hookedRequire);
    process.setSourceMapsEnabled(true);
  }
  registration.set(globalThis, true);
}
