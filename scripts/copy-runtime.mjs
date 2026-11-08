// Puts onnxruntime-node for this machine into dist/onnxruntime (the extension loads it from there;
// node_modules is not packed): its JavaScript bundled into lib/index.cjs, the native addon and the
// library it links next to bin/napi-v6/<platform>/<arch>/, where that script looks for them.
// Run by `npm run build` (copy:runtime) from the root of the project.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const source = join('node_modules', 'onnxruntime-node');
const folder = join('bin', 'napi-v6', process.platform, process.arch);
const target = join('dist', 'onnxruntime');
rmSync(target, { recursive: true, force: true });
if (!existsSync(join(source, folder))) {
    console.warn(`onnxruntime-node has no addon for ${process.platform}-${process.arch}: translating does not work in this build`);
    process.exit(0);
}
await build({
    entryPoints: [join(source, 'dist', 'index.js')],
    bundle: true,
    minify: true,
    platform: 'node',
    format: 'cjs',
    outfile: join(target, 'lib', 'index.cjs'),
    // esbuild would pull in the addons of all platforms: the path is left to be computed at run time, from the bundle's own folder
    plugins: [{
        name: 'addon-at-run-time',
        setup: b => b.onLoad({ filter: /onnxruntime-node[\\/]dist[\\/]binding\.js$/ }, args => ({
            loader: 'js',
            contents: readFileSync(args.path, 'utf8').replace(/require\((`\.\.\/bin\/[^`]+`)\)/, '(path => require(path))($1)'),
        })),
    }],
    logLevel: 'warning',
});
mkdirSync(join(target, folder), { recursive: true });
// libonnxruntime.1.dylib is what the addon links; the versioned file is a copy of it
const files = readdirSync(join(source, folder)).filter(name => !/libonnxruntime\.\d+\.\d+\.\d+\.dylib$|^libonnxruntime\.so\.\d+\.\d+\.\d+$/.test(name));
for (const name of files) cpSync(join(source, folder, name), join(target, folder, name), { dereference: true });
console.log(`onnxruntime-node for ${process.platform}-${process.arch}: ${files.join(', ')} -> ${target}`);
