import assert from "assert"
import path from "path"

import type {
  SourceMap as CivetSourceMap,
  CompileOptions,
  ParseError,
} from "@danielx/civet"
import BundledCivetModule from "@danielx/civet"
import BundledCivetConfigModule from "@danielx/civet/config"

import ts from "typescript"
const { version: typescriptVersion, JsxEmit, isExternalModuleNameRelative } = ts
import type {
  CompilerHost,
  CompilerOptions,
  IScriptSnapshot,
  LanguageServiceHost,
} from "typescript"

const {
  createCompilerHost,
  createLanguageService,
  parseJsonConfigFileContent,
  readConfigFile,
  sys,
} = ts

import { createRequire } from "module"
import { fileURLToPath, pathToFileURL } from "url"
import { TextDocument } from "vscode-languageserver-textdocument"

// Import version from package.json
import pkg from "../../package.json" with { type: 'json' }
import { RemoteConsole } from "vscode-languageserver"
const { version } = pkg

// HACK to get __dirname working in tests with ts-node
// ts-node needs everything to be modules for .civet files to work
// and modules don't have __dirname
var dir: string
try {
  dir = __dirname
} catch (e) {
  //@ts-ignore
  dir = fileURLToPath(import.meta.url)
}

interface SourceMap {
  lines: CivetSourceMap["lines"]
  data: CivetSourceMap["data"]
}

// ts doesn't have this key in the type
interface ResolvedModuleWithFailedLookupLocations extends ts.ResolvedModuleWithFailedLookupLocations {
  failedLookupLocations: string[];
}

export interface FileMeta {
  sourcemapLines: SourceMap["lines"] | undefined
  transpiledDoc: TextDocument | undefined
  parseErrors: (Error | ParseError)[] | undefined
  fatal: boolean // whether errors were fatal during compilation, so no doc
}

interface Host extends LanguageServiceHost {
  getMeta(path: string): FileMeta | undefined
  addOrUpdateDocument(doc: TextDocument): void
}

interface Transpiler {
  extension: string
  /**
   * The target extension of the transpiler (used to force module/commonjs via .mjs, .cjs, .mts, .cts, etc)
   * Must be a valid ts.Extension because those are the kinds that TypeScript understands.
   */
  target: ts.Extension
  compile(path: string, source: string): {
    code: string,
    sourceMap?: SourceMap
    errors?: Error[]
  } | undefined
}

interface Plugin {
  transpilers?: Transpiler[]
}

function TSHost(
  compilationSettings: CompilerOptions,
  initialFileNames: string[],
  baseHost: CompilerHost,
  transpilers: Map<string, Transpiler>,
  logger: Console | RemoteConsole = console,
): Host {
  const { rootDir } = compilationSettings
  assert(rootDir, "Most have root dir for now")

  const scriptFileNames: Set<string> = new Set(initialFileNames.map(getCanonicalFileName))
  const fileMetaData: Map<string, FileMeta> = new Map;

  const pathMap: Map<string, TextDocument> = new Map
  const snapshotMap: Map<string, IScriptSnapshot> = new Map

  let projectVersion = 0;

  const resolutionCache: ts.ModuleResolutionCache = ts.createModuleResolutionCache(rootDir, (fileName) => fileName, compilationSettings);

  let self: Host;

  return self = Object.assign({}, baseHost, {
    getDefaultLibFileName(options: ts.CompilerOptions) {
      // TODO: this might not be correct for dev dev/test envs
      const result = path.join(dir, "lib", ts.getDefaultLibFileName(options))
      return result
    },
    getModuleResolutionCache() {
      return resolutionCache
    },
    /**
     * This is how TypeScript resolves module names when it finds things like `import { foo } from "bar"`.
     * We need to modify this to make sure that TypeScript can resolve our `.civet` files.
     * We default to the original behavior, but if it is a `.civet` file, we resolve it with the `.civet` extension.
     * This requires the `allowNonTsExtensions` option and `allowJs` options to be set to true.
     * Then TypeScript will call `getScriptSnapshot` with the `.civet` extension and we can do the transpilation there.
     */
    resolveModuleNames(moduleNames: string[], containingFile: string, _reusedNames: string[] | undefined, _redirectedReference: ts.ResolvedProjectReference | undefined, compilerOptions: CompilerOptions, _containingSourceFile?: ts.SourceFile) {
      return moduleNames.map(name => {
        // Try to resolve the module using the standard TypeScript logic
        const { resolvedModule } = ts.resolveModuleName(name, containingFile, compilerOptions, self, resolutionCache) as ResolvedModuleWithFailedLookupLocations
        if (resolvedModule) return resolvedModule

        // get the transpiler for the extension
        const extension = getExtensionFromPath(name)
        let transpiler = transpilers.get(extension)
        if (transpiler || !extension) {
          const exists = (transpiler ? sys.fileExists : sys.directoryExists).bind(sys)
          const resolvedModule = (resolved: string) => {
            // Assumes exists(resolved) is true
            // Directories don't yet have a transpiler chosen; try to find one
            // via implicit index file.
            // TODO: Only when state.features & NodeResolutionFeatures.EsmMode
            // TODO: Read package.json as in loadNodeModuleFromDirectoryWorker
            if (!transpiler) {
              for (const [_, t] of transpilers) {
                const index = path.join(resolved, "index" + t.extension)
                if (sys.fileExists(index)) {
                  transpiler = t
                  resolved = index
                  break
                }
              }
              if (!transpiler) return
            }
            // Now sys.fileExists(resolved) should be true
            const { target } = transpiler
            return {
              resolvedFileName: resolved + target,
              extension: target,
              isExternalLibraryImport: false,
            }
          }

          // Mimic tryResolve from
          // https://github.com/microsoft/TypeScript/blob/cf33fd0cde22905effce371bb02484a9f2009023/src/compiler/moduleNameResolver.ts
          // tryLoadModuleUsingOptionalResolutionSettings
          let { baseUrl, paths, pathsBasePath } = compilationSettings
          if (!isExternalModuleNameRelative(name)) { // absolute
            // tryLoadModuleUsingPathsIfEligible
            if (paths) {
              // tryLoadModuleUsingPaths
              // getPathsBasePath from
              // https://github.com/microsoft/TypeScript/blob/bbef6a7a31cff1d0d9f94b082996334baca74caa/src/compiler/utilities.ts#L6317-L6320
              const pathsBase = baseUrl ?? (pathsBasePath as string ||
                (baseHost.getCurrentDirectory?.() ?? '.'))
              // TODO: more closely follow tryParsePatterns from
              // https://github.com/microsoft/TypeScript/blob/bbef6a7a31cff1d0d9f94b082996334baca74caa/src/compiler/utilities.ts#L9743-L9745
              let best = '', bestPrefix = ''
              for (const [pattern, replacements] of Object.entries(paths)) {
                if (pattern.endsWith("*")) {
                  const prefix = pattern.slice(0, -1)
                  if (name.startsWith(prefix)) {
                    for (const replacement of replacements) {
                      const resolved = path.resolve(pathsBase,
                        replacement.replace('*', name.slice(prefix.length)))
                      if (exists(resolved) && prefix.length > bestPrefix.length) {
                        best = resolved
                        bestPrefix = prefix
                      }
                    }
                  }
                } else if (name === pattern) {
                  for (const replacement of replacements) {
                    const resolved = path.resolve(pathsBase, replacement)
                    if (exists(resolved) && pattern.length > bestPrefix.length) {
                      best = resolved
                      bestPrefix = pattern
                    }
                  }
                }
              }
              if (best) return resolvedModule(best)
            }
            // tryLoadModuleUsingBaseUrl
            if (baseUrl) {
              const resolved = path.resolve(baseUrl, name)
              if (exists(resolved)) return resolvedModule(resolved)
            }
          } else { // relative
            // TODO: tryLoadModuleUsingRootDirs
          }

          // This backup resolver is really just for relative paths.
          // TODO: Implement absolute case from tryResolve
          // https://github.com/microsoft/TypeScript/blob/cf33fd0cde22905effce371bb02484a9f2009023/src/compiler/moduleNameResolver.ts#L3221
          const resolved = path.resolve(path.dirname(containingFile), name)
          if (exists(resolved)) return resolvedModule(resolved)
          // TODO: add to resolution cache?
        }

        return undefined
      });
    },
    /**
     * Add a VSCode TextDocument source file.
     * The VSCode document should keep track of its contents and version.
     * This accepts both `.civet` and `.ts` adding the transpiled targets to `scriptFileNames`.
     */
    addOrUpdateDocument(doc: TextDocument): void {
      const path = fileURLToPath(doc.uri)
      // Clear any cached snapshot for this document
      snapshotMap.delete(path)

      // Something may have changed so notify TS by updating the project version
      // Still not too sure exactly how TS uses this. Read `synchronizeHostData` in `typescript/src/sercivces/services.ts` for more info.
      projectVersion++

      const extension = getExtensionFromPath(path)
      const transpiler = transpilers.get(extension)

      // console.log("addOrUpdateDocument", path, extension, transpiler)

      if (transpiler) {
        const { target } = transpiler
        const transpiledPath = path + target

        let transpiledDoc = pathMap.get(transpiledPath)

        if (!transpiledDoc) {
          initTranspiledDoc(transpiledPath)
        }
        // Deleting the snapshot will force a new one to be created when requested
        snapshotMap.delete(transpiledPath)

        // Add the original document to pathMap but *not* scriptFileNames
        // Document map is so that the transpiled doc can update when the original changes
        pathMap.set(path, doc)
        return
      }

      // Plain non-transpiled document
      if (!scriptFileNames.has(path)) {
        scriptFileNames.add(path)
      }

      if (!pathMap.has(path)) {
        pathMap.set(path, doc)
      }

      return
    },
    getMeta(path: string) {
      const transpiledPath = getTranspiledPath(path)
      // This ensures that the transpiled meta data is created
      getOrCreatePathSnapshot(transpiledPath)

      return fileMetaData.get(path)
    },
    getProjectVersion() {
      return projectVersion.toString();
    },
    getCompilationSettings() {
      return compilationSettings;
    },
    /**
     * NOTE: TypeScript likes to pass in paths with only forward slashes regardless of the OS.
     * So we need to normalize them here and in `getScriptVersion`.
     */
    getScriptSnapshot(path: string) {
      path = getCanonicalFileName(path)
      const snap = getOrCreatePathSnapshot(path)

      return snap
    },
    /**
     * NOTE: TypeScript likes to pass in paths with only forward slashes regardless of the OS.
     * So we need to normalize them here and in `getScriptSnapshot`.
     */
    getScriptVersion(path: string) {
      path = getCanonicalFileName(path)
      const version = pathMap.get(path)?.version.toString() || "0"
      // console.log("getScriptVersion", path, version)
      return version
    },
    getScriptFileNames() {
      return Array.from(scriptFileNames)
    },
    writeFile(fileName: string, content: string) {
      logger.log("write " + fileName + " " + content)
    }
  });

  /**
   * Get the source code for a path.
   * Use the VSCode document if it exists otherwise use the file system.
   */
  function getPathSource(path: string): string {
    // Open VSCode docs and transpiled files should all be in the pathMap
    const doc = pathMap.get(path)
    if (doc) {
      return doc.getText()
    }

    if (sys.fileExists(path)) {
      return sys.readFile(path)!
    }

    return ""
  }

  function getTranspiledPath(path: string) {
    const extension = getExtensionFromPath(path)
    const transpiler = transpilers.get(extension)

    if (transpiler) {
      return path + transpiler.target
    }
    return path
  }

  function getOrCreatePathSnapshot(path: string) {
    let snapshot = snapshotMap.get(path)
    if (snapshot) return snapshot

    let transpiler

    // path comes in as transformed (transpiler target extension added), check for 2nd to last extension for transpiler
    // ie .coffee.js or .civet.ts or .hera.cjs

    const exts = getTranspiledExtensionsFromPath(path)
    if (exts && (transpiler = transpilers.get(exts[0]))) {
      // this is a possibly transpiled file

      const sourcePath = removeExtension(path)
      const sourceDoc = pathMap.get(sourcePath)
      let transpiledDoc = pathMap.get(path)
      if (!transpiledDoc) {
        transpiledDoc = initTranspiledDoc(path)
      }

      let source, sourceDocVersion = 0
      if (!sourceDoc) {
        // A source file from the file system
        source = sys.readFile(sourcePath)
      } else {
        source = sourceDoc.getText()
        sourceDocVersion = sourceDoc.version
      }

      // The source document is ahead of the transpiled document
      if (source && sourceDocVersion > transpiledDoc.version) {
        const transpiledCode = doTranspileAndUpdateMeta(transpiledDoc, sourceDocVersion, transpiler, sourcePath, source)
        if (transpiledCode !== undefined) {
          snapshot = Snap(transpiledCode)
        }
      }

      if (!snapshot) {
        // Use the old version if there was an error
        snapshot = Snap(transpiledDoc.getText())
      }

      snapshotMap.set(path, snapshot)
      return snapshot
    }

    // Regular non-transpiled file
    snapshot = Snap(getPathSource(path))
    snapshotMap.set(path, snapshot)
    return snapshot
  }

  function createOrUpdateMeta(path: string, transpiledDoc: TextDocument, sourcemapLines?: SourceMap["lines"], parseErrors?: (Error | ParseError)[], fatal?: boolean) {
    let meta = fileMetaData.get(path)

    if (!meta) {
      meta = {
        sourcemapLines,
        transpiledDoc,
        parseErrors,
        fatal,
      }

      fileMetaData.set(path, meta)
    } else {
      meta.sourcemapLines = sourcemapLines
      meta.parseErrors = parseErrors
      meta.fatal = fatal
    }
  }

  function doTranspileAndUpdateMeta(transpiledDoc: TextDocument, version: number, transpiler: Transpiler, sourcePath: string, sourceCode: string): string | undefined {
    // Definitely do not want to throw errors here, it can make TypeScript very unhappy if it can't get a snapshot/version
    try {
      var result = transpiler.compile(sourcePath, sourceCode)
    } catch (e: unknown) {
      // Add parse errors to meta
      createOrUpdateMeta(sourcePath, transpiledDoc, undefined, [e as Error], true)
      return
    }

    if (result) {
      const { code: transpiledCode, sourceMap, errors } = result
      const sourceMapLines = sourceMap?.lines ?? sourceMap?.data.lines // older Civet
      createOrUpdateMeta(sourcePath, transpiledDoc, sourceMapLines, errors, false)
      TextDocument.update(transpiledDoc, [{ text: transpiledCode }], version)

      return transpiledCode
    }
    return
  }

  function initTranspiledDoc(path: string) {
    // Create an empty document, it will be updated on-demand when `getScriptSnapshot` is called
    // `path` must be the in the format that TypeScript Language Service expects
    const uri = pathToFileURL(path).toString()
    const transpiledDoc = TextDocument.create(uri, "none", -1, "")
    // Add transpiled doc
    pathMap.set(path, transpiledDoc)
    // Transpiled doc gets added to scriptFileNames
    scriptFileNames.add(path)

    return transpiledDoc
  }

  /**
   * Normalize slashes based on the OS.
   */
  function getCanonicalFileName(fileName: string): string {
    return path.join(fileName)
  }
}

function TSService(projectURL = "./", logger: Console | RemoteConsole = console) {
  logger.info("CIVET VSCODE PLUGIN " + version)
  logger.info("TYPESCRIPT " + typescriptVersion)

  const projectPath = fileURLToPath(projectURL)
  const tsConfigPath = `${projectPath}tsconfig.json`
  const { config } = readConfigFile(tsConfigPath, sys.readFile)

  const existingOptions = {
    rootDir: projectPath,
    // This is necessary to load .civet files
    allowNonTsExtensions: true,
    // Better described as "allow non-ts, non-json extensions"
    allowJs: true,
    jsx: JsxEmit.Preserve,
  }

  const parsedConfig = parseJsonConfigFileContent(
    config,
    sys,
    projectPath,
    existingOptions,
    tsConfigPath,
    undefined,
  )
  logger.info("PARSED TSCONFIG\n " + parsedConfig + " " + "\n\n")

  //@ts-ignore
  const baseHost = createCompilerHost(parsedConfig)

  const transpilerDefinitions = [{
    extension: ".civet" as const,
    target: ".tsx" as ts.Extension,
    compile: transpileCivet,
  }].map<[string, Transpiler]>(def => [def.extension, def])

  const transpilers = new Map<string, Transpiler>(transpilerDefinitions)
  // TODO: May want to add transpiled files to fileNames
  const host = TSHost(parsedConfig.options, parsedConfig.fileNames, baseHost, transpilers, logger)
  const service = createLanguageService(host)

  const projectRequire = createRequire(projectURL)

  // Use Civet from the project if present
  let Civet = BundledCivetModule
  let CivetConfig = BundledCivetConfigModule
  const civetPath = "@danielx/civet"
  try {
    projectRequire(`${civetPath}/lsp/package.json`)
    logger.info("USING DEVELOPMENT VERSION OF CIVET -- BE SURE TO yarn build")
  } catch (e) { }
  try {
    Civet = projectRequire(civetPath)
    CivetConfig = projectRequire(`${civetPath}/config`)
    const CivetVersion = projectRequire(`${civetPath}/package.json`).version
    logger.info(`LOADED PROJECT CIVET ${CivetVersion}: ${path.join(projectURL + " " + civetPath)} \n\n`)
  } catch (e) {
    logger.info("USING BUNDLED CIVET")
  }

  let civetConfig: CompileOptions = {}
  CivetConfig.findConfig(projectPath).then(async (configPath) => {
    if (configPath) {
      logger.info("Loading Civet config @ " + configPath)
      const config = await CivetConfig.loadConfig(configPath)
      logger.info("Found civet config!")
      civetConfig = config
    } else logger.info("No Civet config found")
  }).catch((e: unknown) => {
    logger.error("Error loading Civet config " + e)
  })

  return Object.assign({}, service, {
    host,
    getSourceFileName(fileName: string) {
      return remapFileName(fileName, transpilers)
    },
    loadPlugins: async function () {
      const civetFolder = path.join(projectPath, "./.civet/")
      // List files in civet folder
      const civetFiles = sys.readDirectory(civetFolder)

      // One day it would be nice to load plugins that could be transpiled but that is a whole can of worms.
      // VSCode Node versions, esm loaders, etc.
      const pluginFiles = civetFiles.filter(file => file.endsWith("plugin.mjs"))
        .map(file => pathToFileURL(file).toString())

      for (const filePath of pluginFiles) {
        logger.info("Loading plugin " + filePath)
        await loadPlugin(filePath)
      }
    }
  })

  async function loadPlugin(path: string) {
    await import(path)
      .then(({ default: plugin }: { default: Plugin }) => {
        logger.info("Loaded plugin " + plugin)
        plugin.transpilers?.forEach((transpiler: Transpiler) => {
          transpilers.set(transpiler.extension, transpiler)
        })
      })
      .catch(e => {
        logger.error("Error loading plugin " + path + " " + e)
      })
  }

  function transpileCivet(path: string, source: string) {
    const errors: Error[] = [],
      result = Civet.compile(source, {
        ...civetConfig,
        filename: path,
        sourceMap: true,
        errors,
        // We don't process comptime in LSP so don't need async yet
        sync: true,
        comptime: false,
      })

    return Object.assign(result, { errors })
  }
}

/**
 * Returns the extension of the file including the dot.
 * @example
 * getExtension('foo/bar/baz.js') // => '.js'
 * @example
 * getExtension('foo/bar/baz') // => ''
 * @example
 * getExtension('foo/bar/baz.') // => ''
 */
function getExtensionFromPath(path: string): string {
  const match = path.match(lastExtension)
  if (!match) return ""
  return match[0]
}

// Regex to match last extension including dot
const lastExtension = /(?:\.(?:[^./]+))?$/
const lastTwoExtensions = /(\.[^./]*)(\.[^./]*)$/

/**
 * Returns the last two extensions of a path.
 *
 * @example
 * getLastTwoExtensions('foo/bar/baz.js') // => undefined
 * @example
 * getLastTwoExtensions('foo/bar/baz') // => undefined
 * @example
 * getLastTwoExtensions('foo/bar/baz.civet.ts') // => ['.civet', '.ts']
 */
function getTranspiledExtensionsFromPath(path: string): [string, string] | undefined {
  const match = path.match(lastTwoExtensions)
  if (!match) return

  return [match[1], match[2]]
}

/**
 * Removes the last extension from a path.
 * @example
 * removeExtension('foo/bar/baz.js') // => 'foo/bar/baz'
 * @example
 * removeExtension('foo/bar/baz') // => 'foo/bar/baz'
 * @example
 * removeExtension('foo/bar/baz.') // => 'foo/bar/baz.'
 * @example
 * removeExtension('foo/bar/baz.civet.ts') // => 'foo/bar/baz.civet'
 * @example
 * removeExtension('foo/bar.js/baz') // => 'foo/bar.js/baz'
 */
function removeExtension(path: string) {
  return path.replace(/\.[^\/.]+$/, "")
}

function remapFileName(fileName: string, transpilers: Map<string, Transpiler>): string {
  const [extension, target] = getTranspiledExtensionsFromPath(fileName) || []

  if (!extension) return fileName
  const transpiler = transpilers.get(extension)
  if (!transpiler) return fileName

  if (transpiler.target === target) {
    return removeExtension(fileName)
  }

  return fileName
}

// Incremental snapshot example from vue language tools
// https://github.com/vuejs/language-tools/blob/5607f45835ab85e0b5a0747614a4ed9989a28cec/packages/language-core/src/virtualFile/computedFiles.ts#L218
function fullDiffTextChangeRange(oldText: string, newText: string): ts.TextChangeRange | undefined {
  const oldTextLength = oldText.length,
    newTextLength = newText.length,
    minLength = Math.min(oldTextLength, newTextLength);

  for (let start = 0; start < minLength; start++) {
    if (oldText[start] !== newText[start]) {
      let end = oldTextLength;
      let stop = minLength - start;
      for (let i = 0; i < stop; i++) {
        if (oldText[oldTextLength - i - 1] !== newText[newTextLength - i - 1]) {
          break;
        }
        end--;
      }

      let length = end - start;
      let newLength = length + (newTextLength - oldTextLength);
      if (newLength < 0) {
        length -= newLength;
        newLength = 0;
      }

      return {
        span: { start, length },
        newLength,
      };
    }
  }

  return undefined;
}

const Snap = (newText: string) => {
  const changeRanges = new Map<ts.IScriptSnapshot, ts.TextChangeRange | undefined>();

  const snapshot: ts.IScriptSnapshot = {
    getText: (start, end) => newText.slice(start, end),
    getLength: () => newText.length,
    getChangeRange(oldSnapshot) {
      if (!changeRanges.has(oldSnapshot)) {
        changeRanges.set(oldSnapshot, undefined);
        const oldText = oldSnapshot.getText(0, oldSnapshot.getLength());
        const changeRange = fullDiffTextChangeRange(oldText, newText);
        if (changeRange) {
          changeRanges.set(oldSnapshot, changeRange);
        }
      }

      return changeRanges.get(oldSnapshot);
    },
  };

  return snapshot as ts.IScriptSnapshot;
}

export default TSService
