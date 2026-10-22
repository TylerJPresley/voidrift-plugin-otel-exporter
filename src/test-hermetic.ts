/**
 * Hermetic per-worker guard (per-package; carried by this package so it stays
 * independently publishable — NO shared cross-package file).
 *
 * The temp root for the whole run is created and OWNED by the vitest
 * `globalSetup` (`test-hermetic.global.ts`), which runs in the MAIN process,
 * redirects `HOME`/`XDG_CONFIG_HOME` (and `APPDATA` on win32) at it BEFORE any
 * worker starts, and removes it on teardown. Workers inherit that redirected
 * environment.
 *
 * This per-worker setup therefore CREATES NO DIRECTORY. It only:
 *   1. asserts, at module load (before any test), that `HOME` and
 *      `XDG_CONFIG_HOME` already point inside a `vr-hermetic-*` temp root —
 *      failing LOUDLY if the globalSetup did not run or the environment was not
 *      inherited, so a worker can never silently fall back to the real dir; and
 *   2. re-asserts the redirect in `afterAll`. The REAL `~/.config/voidrift` is guarded by the main-process
 *      `globalSetup` (test-hermetic.global.ts), which fingerprints it before the run and fails the whole
 *      run if it changed. (A per-worker count of the shared TEMP config dir was removed: workers share
 *      one temp root, so a concurrent file legitimately deleting a file made it flaky.)
 *
 * The environment is NEVER restored within the worker (the late-write
 * protection): a late asynchronous write that resolves its directory after
 * teardown still lands inside the temp root, never the real dir.
 */
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

/** Resolve the real `~/.config/voidrift` from the CURRENT environment. In a
 * correctly set-up worker this is the hermetic temp dir; the ORIGINAL real dir
 * is only reachable here if the redirect failed — which the assertion below
 * rejects before any test runs. */
function configDirFrom(env: { xdg?: string | undefined; home?: string | undefined }): string {
  const home = env.home ?? os.homedir();
  const base = env.xdg ?? path.join(home, ".config");
  return path.join(base, "voidrift");
}

// Assert the globalSetup redirect is in place BEFORE any test (and before any
// top-level `createCore` a test file might reach in its own setup). This worker
// creates NOTHING; it only verifies it inherited a hermetic environment. The
// invariant is that the RESOLVED config dir falls inside the run's
// `vr-hermetic-*` temp root — a test may legitimately unset `XDG_CONFIG_HOME`
// to exercise the `HOME/.config` fallback, which is still hermetic because
// `HOME` points inside the temp root.
function assertHermetic(): void {
  const dir = configDirFrom({ xdg: process.env["XDG_CONFIG_HOME"], home: process.env["HOME"] });
  if (!dir.includes("vr-hermetic-")) {
    throw new Error(
      `hermetic setup missing: the resolved config dir (${dir}) must fall inside the run's ` +
        `vr-hermetic-* temp root created by test-hermetic.global.ts ` +
        `(HOME=${String(process.env["HOME"])}, XDG_CONFIG_HOME=${String(process.env["XDG_CONFIG_HOME"])}). ` +
        `The globalSetup did not run or its environment was not inherited by this worker.`,
    );
  }
}
assertHermetic();

afterAll(() => {
  // Do NOT restore the env (late-write protection) and do NOT remove any dir (the globalSetup owns the
  // temp root). Only re-assert the redirect: a worker must still resolve inside the run's temp root.
  assertHermetic();
});
