// Runs test/e2e/suite.cjs in VS Code's real extension host, in a separate instance with an empty
// profile (a window opens for a few minutes; `opus-mt-en-ru`, 115 MB, is downloaded):   node test/e2e/run.mjs <folder with the models>   (needs a build)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CODE = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
const TIMEOUT = 8 * 60_000;
const models = resolve(process.argv[2] ?? '');
const root = resolve(import.meta.dirname, '../..');
const scratch = mkdtempSync(join(tmpdir(), 'translator-e2e-'));
mkdirSync(join(scratch, 'data/User'), { recursive: true });
mkdirSync(join(scratch, 'workspace'));
writeFileSync(join(scratch, 'data/User/settings.json'), JSON.stringify({
    'translator.models': ['opus-mt-ru-en', 'm2m100_418M'].map(name => join(models, name)),
    'translator.targetLanguage': 'ru',
    'window.restoreWindows': 'none', 'update.mode': 'none', 'extensions.autoUpdate': false, 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none',
}));
const result = join(scratch, 'result.json');
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(VSCODE_|ELECTRON_|CLAUDE)/.test(name)));
const child = spawn(CODE, [
    `--user-data-dir=${join(scratch, 'data')}`, `--extensions-dir=${join(scratch, 'extensions')}`,
    `--extensionDevelopmentPath=${root}`, `--extensionTestsPath=${join(root, 'test/e2e/suite.cjs')}`,
    '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-telemetry', join(scratch, 'workspace'),
], { env: { ...env, TRANSLATOR_E2E_RESULT: result }, stdio: 'ignore' });
const timer = setTimeout(() => child.kill(), TIMEOUT);
child.on('exit', (code, signal) => {
    clearTimeout(timer);
    let failed = true;
    try {
        const { electron, node, log } = JSON.parse(readFileSync(result, 'utf8'));
        console.log(`extension host: Electron ${electron}, Node ${node}`);
        for (const { name, ms, value, error } of log) console.log(`${error ? 'FAIL' : 'ok  '} ${name} (${ms} ms): ${error ?? JSON.stringify(value)}`);
        failed = log.some(entry => entry.error);
    } catch (error) {
        console.error(`no result (exit ${code}, ${signal}): ${error.message}`);
    }
    rmSync(scratch, { recursive: true, force: true });
    process.exit(failed ? 1 : 0);
});
