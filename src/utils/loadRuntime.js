import { createRequire } from 'node:module';
import { join } from 'node:path';

/** @type {{ module?: any, error?: Error } | null} what was loaded, or why it was not */
let loaded = null;

/**
 * onnxruntime-node from `dist/onnxruntime` (`scripts/copy-runtime.mjs`; node_modules is not packed), loaded once.
 * @param {string} extensionPath
 * @returns {any} the module
 * @throws {Error} when it is not in this build
 */
export function loadRuntime(extensionPath) {
    if (!loaded) {
        try {
            loaded = { module: createRequire(join(extensionPath, 'dist', 'extension.cjs'))('./onnxruntime/lib/index.cjs') };
        } catch (error) {
            loaded = { error: error instanceof Error ? error : new Error(String(error)) };
        }
    }
    if (loaded.error) throw loaded.error;
    return loaded.module;
}
