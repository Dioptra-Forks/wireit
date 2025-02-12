/**
 * @license
 * Copyright 2022 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as pathlib from 'path';
import * as fs from '../util/fs.js';
import {WorkerPool} from '../util/worker-pool.js';
import {getScriptDataDir} from '../util/script-data-dir.js';
import {unreachable} from '../util/unreachable.js';
import {glob, GlobOutsideCwdError} from '../util/glob.js';
import {deleteEntries} from '../util/delete.js';
import lockfile from 'proper-lockfile';
import {ScriptChildProcess} from '../script-child-process.js';
import {BaseExecutionWithCommand} from './base.js';
import {Fingerprint} from '../fingerprint.js';
import {computeManifestEntry} from '../util/manifest.js';

import type {Result} from '../error.js';
import type {ExecutionResult} from './base.js';
import type {Executor} from '../executor.js';
import type {StandardScriptConfig} from '../config.js';
import type {FingerprintString} from '../fingerprint.js';
import type {Logger} from '../logging/logger.js';
import type {Cache, CacheHit} from '../caching/cache.js';
import type {Failure, StartCancelled} from '../event.js';
import type {AbsoluteEntry} from '../util/glob.js';
import type {FileManifestEntry, FileManifestString} from '../util/manifest.js';
import {Stats} from 'fs';

type StandardScriptExecutionState =
  | 'before-running'
  | 'running'
  | 'after-running';

/**
 * Execution for a {@link StandardScriptConfig}.
 */
export class StandardScriptExecution extends BaseExecutionWithCommand<StandardScriptConfig> {
  #state: StandardScriptExecutionState = 'before-running';
  readonly #cache?: Cache;
  readonly #workerPool: WorkerPool;

  constructor(
    config: StandardScriptConfig,
    executor: Executor,
    workerPool: WorkerPool,
    cache: Cache | undefined,
    logger: Logger,
  ) {
    super(config, executor, logger);
    this.#workerPool = workerPool;
    this.#cache = cache;
  }

  #ensureState(state: StandardScriptExecutionState): void {
    if (this.#state !== state) {
      throw new Error(`Expected state ${state} but was ${this.#state}`);
    }
  }

  protected async _execute(): Promise<ExecutionResult> {
    try {
      this.#ensureState('before-running');

      const dependencyFingerprints = await this._executeDependencies();
      if (!dependencyFingerprints.ok) {
        dependencyFingerprints.error.push(this.#startCancelledEvent);
        return dependencyFingerprints;
      }

      // Significant time could have elapsed since we last checked because our
      // dependencies had to finish.
      if (this.#shouldNotStart) {
        return {ok: false, error: [this.#startCancelledEvent]};
      }

      return await this.#acquireSystemLockIfNeeded(async () => {
        // Note we must wait for dependencies to finish before generating the
        // cache key, because a dependency could create or modify an input file to
        // this script, which would affect the key.
        const fingerprintResponse = await Fingerprint.compute(
          this._config,
          dependencyFingerprints.value,
        );
        if (!fingerprintResponse.ok) {
          return {
            ok: false,
            error: [fingerprintResponse.error],
          };
        }
        const fingerprint = fingerprintResponse.value;
        if (
          this._executor.failedInPreviousWatchIteration(
            this._config,
            fingerprint,
          )
        ) {
          return {
            ok: false,
            error: [
              {
                script: this._config,
                type: 'failure',
                reason: 'failed-previous-watch-iteration',
              },
            ],
          };
        }
        if (await this.#fingerprintIsFresh(fingerprint)) {
          const manifestFresh = await this.#outputManifestIsFresh();
          if (!manifestFresh.ok) {
            return {ok: false, error: [manifestFresh.error]};
          }
          if (manifestFresh.value) {
            return this.#handleFresh(fingerprint);
          }
        }

        // Computing the fingerprint can take some time, and the next operation is
        // destructive. Another good opportunity to check if we should still
        // start.
        if (this.#shouldNotStart) {
          return {ok: false, error: [this.#startCancelledEvent]};
        }

        const cacheHit = fingerprint.data.fullyTracked
          ? await this.#cache?.get(this._config, fingerprint)
          : undefined;
        if (this.#shouldNotStart) {
          return {ok: false, error: [this.#startCancelledEvent]};
        }
        if (cacheHit !== undefined) {
          return this.#handleCacheHit(cacheHit, fingerprint);
        }

        return this.#handleNeedsRun(fingerprint);
      });
    } finally {
      this._servicesNotNeeded.resolve();
    }
  }

  /**
   * Whether we should return early instead of starting this script.
   *
   * We should check this as the first thing we do, and then after any
   * significant amount of time might have elapsed.
   */
  get #shouldNotStart(): boolean {
    return this._executor.shouldStopStartingNewScripts;
  }

  /**
   * Convenience to generate a cancellation failure event for this script.
   */
  get #startCancelledEvent(): StartCancelled {
    return {
      script: this._config,
      type: 'failure',
      reason: 'start-cancelled',
    };
  }

  /**
   * Acquire a system-wide lock on the execution of this script, if the script
   * has any output files that require it.
   */
  async #acquireSystemLockIfNeeded<T>(
    workFn: () => Promise<T>,
  ): Promise<T | {ok: false; error: [StartCancelled]}> {
    if (this._config.output?.values.length === 0) {
      return workFn();
    }

    // The proper-lockfile library is designed to give an exclusive lock for a
    // *file*. That's slightly misaligned with our use-case, because there's no
    // particular file we need a lock for -- our lock is for the execution of
    // this script.
    //
    // We can still use the library, we just need to pick some arbitrary file to
    // ask it to lock for us. It actually errors if the file doesn't exist. So
    // we end up with a mostly pointless file, and an adjacent "<file>.lock"
    // directory that manages the lock (to acquire a lock, it does a mkdir for
    // "<file>.lock", which will atomically succeed or fail depending on whether
    // it already existed).
    //
    // TODO(aomarks) We could make our own implementation that directly takes a
    // directory to mkdir and doesn't care about the file. There are some nice
    // details proper-lockfile handles.
    const lockFile = pathlib.join(this.#dataDir, 'lock');
    await fs.mkdir(pathlib.dirname(lockFile), {recursive: true});
    await fs.writeFile(lockFile, '', 'utf8');
    let loggedLocked = false;
    while (true) {
      try {
        const release = await lockfile.lock(lockFile, {
          // If this many milliseconds has elapsed since the lock mtime was last
          // updated, proper-lockfile will delete it and attempt to acquire the
          // lock again. This handles the case where a process holding the lock
          // hard-crashed.
          stale: 10_000,
          // How frequently the mtime for the lock will be updated while it is
          // being held. This should be some smallish factor of "stale" so that
          // we're unlikely to appear stale when we're actually still working on
          // the script.
          update: 2000,
        });
        try {
          return await workFn();
        } finally {
          await release();
        }
      } catch (error) {
        if ((error as {code: string}).code === 'ELOCKED') {
          if (!loggedLocked) {
            // Only log this once.
            this._logger.log({
              script: this._config,
              type: 'info',
              detail: 'locked',
            });
            loggedLocked = true;
          }
          // Wait a moment before attempting to acquire the lock again.
          await new Promise((resolve) => setTimeout(resolve, 200));
          if (this.#shouldNotStart) {
            return {ok: false, error: [this.#startCancelledEvent]};
          }
        } else {
          throw error;
        }
      }
    }
  }

  /**
   * Check whether the given fingerprint matches the current one from the
   * `.wireit` directory.
   */
  async #fingerprintIsFresh(fingerprint: Fingerprint): Promise<boolean> {
    if (!fingerprint.data.fullyTracked) {
      return false;
    }
    const prevFingerprint = await this.#readPreviousFingerprint();
    return prevFingerprint !== undefined && fingerprint.equal(prevFingerprint);
  }

  /**
   * Handle the outcome where the script is already fresh.
   */
  #handleFresh(fingerprint: Fingerprint): ExecutionResult {
    this._logger.log({
      script: this._config,
      type: 'success',
      reason: 'fresh',
    });
    return {ok: true, value: fingerprint};
  }

  /**
   * Handle the outcome where the script was stale and we got a cache hit.
   */
  async #handleCacheHit(
    cacheHit: CacheHit,
    fingerprint: Fingerprint,
  ): Promise<ExecutionResult> {
    // Optimization: early signal that services are not needed while we're still
    // restoring from cache.
    this._servicesNotNeeded.resolve();

    // Delete the fingerprint and other files. It's important we do this before
    // restoring from cache, because we don't want to think that the previous
    // fingerprint is still valid when it no longer is.
    await this.#prepareDataDir();

    // If we are restoring from cache, we should always delete existing output.
    // The purpose of "clean:false" and "clean:if-file-deleted" is to allow
    // tools with incremental build (like tsc --build) to work.
    //
    // However, this only applies when the tool is able to observe each
    // incremental change to the input files. When we restore from cache, we are
    // directly replacing the output files, and not invoking the tool at all, so
    // there is no way for the tool to do any cleanup.
    await this.#cleanOutput();

    await cacheHit.apply();
    this.#state = 'after-running';

    const writeFingerprintPromise = this.#writeFingerprintFile(fingerprint);
    const outputFilesAfterRunning = await this.#globOutputFilesAfterRunning();
    if (!outputFilesAfterRunning.ok) {
      return {ok: false, error: [outputFilesAfterRunning.error]};
    }
    if (outputFilesAfterRunning.value !== undefined) {
      const outputManifest = await this.#computeOutputManifest(
        outputFilesAfterRunning.value,
      );
      if (!outputManifest.ok) {
        return {ok: false, error: [outputManifest.error]};
      }
      await this.#writeOutputManifest(outputManifest.value);
    }
    await writeFingerprintPromise;

    this._logger.log({
      script: this._config,
      type: 'success',
      reason: 'cached',
    });

    return {ok: true, value: fingerprint};
  }

  /**
   * Handle the outcome where the script was stale and we need to run it.
   */
  async #handleNeedsRun(fingerprint: Fingerprint): Promise<ExecutionResult> {
    // Check if we should clean before we delete the fingerprint file, because
    // we sometimes need to read the previous fingerprint file to determine
    // this.
    const shouldClean = await this.#shouldClean(fingerprint);

    // Delete the fingerprint and other files. It's important we do this before
    // starting the command, because we don't want to think that the previous
    // fingerprint is still valid when it no longer is.
    await this.#prepareDataDir();

    if (shouldClean) {
      const result = await this.#cleanOutput();
      if (!result.ok) {
        return {ok: false, error: [result.error]};
      }
    }

    const childResult = await this.#workerPool.run(async () => {
      // Significant time could have elapsed since we last checked because of
      // parallelism limits.
      if (this.#shouldNotStart) {
        return {ok: false, error: this.#startCancelledEvent};
      }

      let earlyServiceTermination: Failure | undefined;
      if (this._config.services.length > 0) {
        const servicesStarted = await this._startServices();
        if (!servicesStarted.ok) {
          return servicesStarted;
        }

        void this._anyServiceTerminated.then(() => {
          if (this.#state === 'after-running') {
            // This is expected after we're done.
            return;
          }
          earlyServiceTermination = {
            script: this._config,
            type: 'failure',
            reason: 'dependency-service-exited-unexpectedly',
          };
          // Stop running. If a service we depend on is down, then we know we're
          // in an invalid state too.
          child.kill();
          this._executor.notifyFailure();
        });
      }

      this.#state = 'running';
      this._logger.log({
        script: this._config,
        type: 'info',
        detail: 'running',
      });

      const child = new ScriptChildProcess(
        // Unfortunately TypeScript doesn't automatically narrow this type
        // based on the undefined-command check we did just above.
        this._config,
      );

      void this._executor.shouldKillRunningScripts.then(() => {
        child.kill();
      });

      child.stdout.on('data', (data: string | Buffer) => {
        this._logger.log({
          script: this._config,
          type: 'output',
          stream: 'stdout',
          data,
        });
      });

      child.stderr.on('data', (data: string | Buffer) => {
        this._logger.log({
          script: this._config,
          type: 'output',
          stream: 'stderr',
          data,
        });
      });

      const result = await child.completed;
      if (result.ok) {
        if (earlyServiceTermination !== undefined) {
          return {ok: false, error: earlyServiceTermination};
        } else {
          this._logger.log({
            script: this._config,
            type: 'success',
            reason: 'exit-zero',
          });
        }
      } else {
        this._logger.log(result.error);
        // This failure will propagate to the Executor eventually anyway, but
        // asynchronously.
        //
        // The problem with that is that when parallelism is constrained, the
        // next script waiting on this WorkerPool might start running before
        // the failure information propagates, because returning from this
        // function immediately unblocks the next worker.
        //
        // By directly notifying the Executor about the failure while we are
        // still inside the WorkerPool callback, we prevent this race
        // condition.
        this._executor.notifyFailure();
      }
      return result;
    });

    this.#state = 'after-running';

    if (!childResult.ok) {
      this._executor.registerWatchIterationFailure(this._config, fingerprint);
      return {
        ok: false,
        error: Array.isArray(childResult.error)
          ? childResult.error
          : [childResult.error],
      };
    }

    // Optimization: early signal that services are no longer needed while we're
    // still writing the fingerprint file etc.
    this._servicesNotNeeded.resolve();

    const writeFingerprintPromise = this.#writeFingerprintFile(fingerprint);
    const outputFilesAfterRunning = await this.#globOutputFilesAfterRunning();
    if (!outputFilesAfterRunning.ok) {
      return {ok: false, error: [outputFilesAfterRunning.error]};
    }
    if (outputFilesAfterRunning.value !== undefined) {
      const outputManifest = await this.#computeOutputManifest(
        outputFilesAfterRunning.value,
      );
      if (!outputManifest.ok) {
        return {ok: false, error: [outputManifest.error]};
      }
      await this.#writeOutputManifest(outputManifest.value);
    }
    await writeFingerprintPromise;

    if (fingerprint.data.fullyTracked) {
      const result = await this.#saveToCacheIfPossible(fingerprint);
      if (!result.ok) {
        return {ok: false, error: [result.error]};
      }
    }

    return {ok: true, value: fingerprint};
  }

  async #shouldClean(fingerprint: Fingerprint) {
    const cleanValue = this._config.clean;
    switch (cleanValue) {
      case true: {
        return true;
      }
      case false: {
        return false;
      }
      case 'if-file-deleted': {
        const prevFingerprint = await this.#readPreviousFingerprint();
        if (prevFingerprint === undefined) {
          // If we don't know the previous fingerprint, then we can't know
          // whether any input files were removed. It's safer to err on the
          // side of cleaning.
          return true;
        }
        return this.#anyInputFilesDeletedSinceLastRun(
          fingerprint,
          prevFingerprint,
        );
      }
      default: {
        throw new Error(
          `Unhandled clean setting: ${unreachable(cleanValue) as string}`,
        );
      }
    }
  }

  /**
   * Compares the current set of input file names to the previous set of input
   * file names, and returns whether any files have been removed.
   */
  #anyInputFilesDeletedSinceLastRun(
    curFingerprint: Fingerprint,
    prevFingerprint: Fingerprint,
  ): boolean {
    const curFiles = Object.keys(curFingerprint.data.files);
    const prevFiles = Object.keys(prevFingerprint.data.files);
    if (curFiles.length < prevFiles.length) {
      return true;
    }
    const newFilesSet = new Set(curFiles);
    for (const oldFile of prevFiles) {
      if (!newFilesSet.has(oldFile)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Save the current output files to the configured cache if possible.
   */
  async #saveToCacheIfPossible(
    fingerprint: Fingerprint,
  ): Promise<Result<void>> {
    if (this.#cache === undefined) {
      return {ok: true, value: undefined};
    }
    const paths = await this.#globOutputFilesAfterRunning();
    if (!paths.ok) {
      return paths;
    }
    if (paths.value === undefined) {
      return {ok: true, value: undefined};
    }
    await this.#cache.set(this._config, fingerprint, paths.value);
    return {ok: true, value: undefined};
  }

  /**
   * Glob the output files for this script and cache them, but throw unless the
   * script has not yet started running or been restored from cache.
   */
  #globOutputFilesBeforeRunning(): Promise<
    Result<AbsoluteEntry[] | undefined>
  > {
    this.#ensureState('before-running');
    return (this.#cachedOutputFilesBeforeRunning ??= this.#globOutputFiles());
  }
  #cachedOutputFilesBeforeRunning?: Promise<
    Result<AbsoluteEntry[] | undefined>
  >;

  /**
   * Glob the output files for this script and cache them, but throw unless the
   * script has finished running or been restored from cache.
   */
  #globOutputFilesAfterRunning(): Promise<Result<AbsoluteEntry[] | undefined>> {
    this.#ensureState('after-running');
    return (this.#cachedOutputFilesAfterRunning ??= this.#globOutputFiles());
  }
  #cachedOutputFilesAfterRunning?: Promise<Result<AbsoluteEntry[] | undefined>>;

  /**
   * Glob the output files for this script, or return undefined if output files
   * are not defined.
   */
  async #globOutputFiles(): Promise<Result<AbsoluteEntry[] | undefined>> {
    if (this._config.output === undefined) {
      return {ok: true, value: undefined};
    }
    try {
      return {
        ok: true,
        value: await glob(this._config.output.values, {
          cwd: this._config.packageDir,
          followSymlinks: false,
          includeDirectories: true,
          expandDirectories: true,
          throwIfOutsideCwd: true,
        }),
      };
    } catch (error) {
      if (error instanceof GlobOutsideCwdError) {
        // TODO(aomarks) It would be better to do this in the Analyzer by
        // looking at the output glob patterns. See
        // https://github.com/google/wireit/issues/64.
        return {
          ok: false,
          error: {
            type: 'failure',
            reason: 'invalid-config-syntax',
            script: this._config,
            diagnostic: {
              severity: 'error',
              message: `Output files must be within the package: ${error.message}`,
              location: {
                file: this._config.declaringFile,
                range: {
                  offset: this._config.output.node.offset,
                  length: this._config.output.node.length,
                },
              },
            },
          },
        };
      }
      throw error;
    }
  }

  /**
   * Get the directory name where Wireit data can be saved for this script.
   */
  get #dataDir(): string {
    return getScriptDataDir(this._config);
  }

  /**
   * Get the path where the current fingerprint is saved for this script.
   */
  get #fingerprintFilePath(): string {
    return pathlib.join(this.#dataDir, 'fingerprint');
  }

  /**
   * Read this script's previous fingerprint from `fingerprint` file in the
   * `.wireit` directory. Cached after first call.
   */
  async #readPreviousFingerprint(): Promise<Fingerprint | undefined> {
    if (this.#cachedPreviousFingerprint === undefined) {
      this.#cachedPreviousFingerprint = (async () => {
        try {
          return Fingerprint.fromString(
            (await fs.readFile(
              this.#fingerprintFilePath,
              'utf8',
            )) as FingerprintString,
          );
        } catch (error) {
          if ((error as {code?: string}).code === 'ENOENT') {
            return undefined;
          }
          throw error;
        }
      })();
    }
    return this.#cachedPreviousFingerprint;
  }
  #cachedPreviousFingerprint?: Promise<Fingerprint | undefined>;

  /**
   * Write this script's fingerprint file.
   */
  async #writeFingerprintFile(fingerprint: Fingerprint): Promise<void> {
    await fs.mkdir(this.#dataDir, {recursive: true});
    await fs.writeFile(this.#fingerprintFilePath, fingerprint.string, 'utf8');
  }

  /**
   * Delete the fingerprint and other files for this script from the previous
   * run, and ensure the data directory exists.
   */
  async #prepareDataDir(): Promise<void> {
    await Promise.all([
      fs.rm(this.#fingerprintFilePath, {force: true}),
      fs.mkdir(this.#dataDir, {recursive: true}),
    ]);
  }

  /**
   * Delete all files matched by this script's "output" glob patterns.
   */
  async #cleanOutput(): Promise<Result<void>> {
    const files = await this.#globOutputFilesBeforeRunning();
    if (!files.ok) {
      return files;
    }
    if (files.value === undefined) {
      return {ok: true, value: undefined};
    }
    await deleteEntries(files.value);
    return {ok: true, value: undefined};
  }

  /**
   * Compute the output manifest for this script, which is the sorted list of
   * all output filenames, along with filesystem metadata that we assume is good
   * enough for checking that a file hasn't changed: ctime, mtime, and bytes.
   */
  async #computeOutputManifest(
    outputEntries: AbsoluteEntry[],
  ): Promise<Result<FileManifestString>> {
    outputEntries.sort((a, b) => a.path.localeCompare(b.path));
    const stats: Stats[] = [];
    const deleted: string[] = [];
    await Promise.all(
      outputEntries.map(async (entry, i) => {
        try {
          stats[i] = await fs.lstat(entry.path);
        } catch (e) {
          if ((e as {code?: string}).code === 'ENOENT') {
            deleted.push(entry.path);
          } else {
            throw e;
          }
        }
      }),
    );
    if (deleted.length > 0) {
      return {
        ok: false,
        error: {
          type: 'failure',
          reason: 'output-file-deleted-unexpectedly',
          script: this._config,
          filePaths: deleted.sort(),
        },
      };
    }
    const manifest: Record<string, FileManifestEntry> = {};
    for (let i = 0; i < outputEntries.length; i++) {
      manifest[outputEntries[i]!.path] = computeManifestEntry(stats[i]!);
    }
    return {ok: true, value: JSON.stringify(manifest) as FileManifestString};
  }

  /**
   * Check whether the current manifest of output files matches the one from the
   * `.wireit` directory.
   */
  async #outputManifestIsFresh(): Promise<Result<boolean>> {
    const oldManifestPromise = this.#readPreviousOutputManifest();
    const outputFilesBeforeRunning = await this.#globOutputFilesBeforeRunning();
    if (!outputFilesBeforeRunning.ok) {
      return outputFilesBeforeRunning;
    }
    if (outputFilesBeforeRunning.value === undefined) {
      return {ok: true, value: false};
    }
    const newManifest = await this.#computeOutputManifest(
      outputFilesBeforeRunning.value,
    );
    if (!newManifest.ok) {
      return newManifest;
    }
    const oldManifest = await oldManifestPromise;
    if (oldManifest === undefined) {
      return {ok: true, value: false};
    }
    const equal = newManifest.value === oldManifest;
    if (!equal) {
      this._logger.log({
        script: this._config,
        type: 'info',
        detail: 'output-modified',
      });
    }
    return {ok: true, value: equal};
  }

  /**
   * Read this script's previous output manifest file from the `manifest` file
   * in the `.wireit` directory. Not cached.
   */
  async #readPreviousOutputManifest(): Promise<FileManifestString | undefined> {
    try {
      return (await fs.readFile(
        this.#outputManifestFilePath,
        'utf8',
      )) as FileManifestString;
    } catch (error) {
      if ((error as {code?: string}).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Write this script's output manifest file.
   */
  async #writeOutputManifest(
    outputManifest: FileManifestString,
  ): Promise<void> {
    await fs.mkdir(this.#dataDir, {recursive: true});
    await fs.writeFile(this.#outputManifestFilePath, outputManifest, 'utf8');
  }

  /**
   * Get the path where the current output manifest is saved for this script.
   */
  get #outputManifestFilePath(): string {
    return pathlib.join(this.#dataDir, 'manifest');
  }
}
