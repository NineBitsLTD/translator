# AGENTS.md

Guidelines for AI agents (Claude, Gemini, GPT, Codex, etc.)

## Overview

VS Code extension **Translator** (`translator`): translates text on the device with ONNX models, built like `../tts-stt-aloud` (a side bar, models downloaded from Hugging Face with progress or chosen on the disk, a native runtime packed per platform, an API for other extensions). It contributes:
- A **side bar** (activity bar container `translator`, webview view `translator.panel`, `src/components/TranslatorPanel.js`, webview `src/panel.js` → `dist/js/panel.js`, `src/panel/TranslatorView.js`, `src/scss/panel.scss`): from / to languages (From: Auto tells the language by the letters of the text), the text and its translation, Selection and Clipboard (take the text and translate it), Copy, Replace selection; a pair with no model shows what to download; **Models**: those installed (a check box: whether translations use it; reveal, remove) and those being downloaded (how many MB of how many, updated as they come), **Add a model**: a modal dialog (`src/panel/ModelDialog.js`, as in tts-stt-aloud) — a folder on the disk, or the catalog with a filter by language.
- **Speech**, when `ninebits.tts-stt-aloud` is installed and enabled (`src/components/SpeechExtension.js`, through its API; `state.speech`; no dependency in the manifest): a button under each field reads it aloud, a button under the source records a phrase (10 s for it to begin, a pause of 1 s ends it, a minute at most) and translates it like Selection. Always at `priority: 0`, the lowest: another speech goes first. The language of the voice: From (Auto: told by the letters), the target of the last translation. Whisper recognizes in the language of the settings of that extension (its `record` takes none). `stop` of its API is shared by all extensions, so only what was asked for here is stopped.
- **Commands**: `translator.translateSelection` (into the side bar; also in the editor's context menu), `translator.replaceSelection` (and `translator.translateInPlace`, the same under the short title Translate: in the editor title while text is selected in a text file, not in the palette; into the target language of the side bar, left as it is when the file changed meanwhile), `translator.translateClipboard`, `translator.translateFile` (a new untitled editor of the same language) — `src/components/TextCommands.js`; hidden: `translator.translate` (texts, options) and `translator.downloadModel` (key: gives why it did not begin, '' when it began).
- **An API**: `activate` returns `{ translate(textOrTexts, { from, to, markdown, signal }), detectLanguage(text), canTranslate(from, to), onDidChangeModels }`. `translate` answers in the form given and rejects with `code: 'NO_MODEL'` (`from`, `to`).
- **Settings** (`translator.*`, scope `application`, `TranslatorSettings`): `sourceLanguage` (`auto`), `targetLanguage` ('' : the language of VS Code), `alternateLanguage` (a text told to be in the target language goes into this one; `en`), `beams` (0: what the model is made with), `idleMinutes` (5), `models` (folders), `inactiveModels` (those of them unchecked: the engine does not see them; a new model is active).

## Commands

```bash
npm run build      # full production build into dist/ (clean → extension → webview → css → codicons → runtime)
npm run watch      # build once, then run all watchers concurrently (esbuild --watch + sass)
npm run pack       # scripts/pack.mjs: vsce runs the build, then packs translator-<platform>-<arch>-<version>.vsix for this machine
npm test           # node --test test/*.test.js; the tests of real models run with TRANSLATOR_TEST_MODELS=<folder with opus-mt-en-ru, opus-mt-ru-en, m2m100_418M>
node test/e2e/run.mjs <models folder>   # test/e2e/suite.cjs in VS Code's real extension host, a separate instance with an empty profile (needs a build; downloads opus-mt-en-ru)
node test/harness/server.mjs            # the side bar in a browser with a fake host → http://127.0.0.1:3398/ (needs a build)
npx eslint src     # lint (no "lint" npm script)
```

To run/debug the extension, launch an Extension Development Host with `--extensionDevelopmentPath` of this folder. The entry point is `dist/extension.cjs`, so **build (or watch) before launching**.

## Build architecture

Source is authored as **ESM** (`"type": "module"`) and bundled with **esbuild**, the runtime copied next to it:

1. **Extension host** — `src/extension.js` → `dist/extension.cjs` (CJS for Node, `vscode` external): `src/components/` (`TranslatorPanel`, `TextCommands`, `Translation` — what the panel, commands and API share —, `TranslationModels`, `modelCatalog`, `TranslatorSettings`, `SpeechExtension`), `src/engine/`, `src/utils/` (`createNonce`, `guessLanguage` from tts-stt-aloud, `loadRuntime`).
2. **Webview** — `src/panel.js` → `dist/js/panel.js`: `src/panel/` (`TranslatorView`, `ModelDialog`, `HostRequests`, `dom`). Its texts come from the host (`TranslatorPanel._strings`). The icons are codicons: `copy:codicons` puts their CSS and font into `dist/codicons/`.
3. **The engine** — `src/engine/` does not import `vscode`: `new TranslatorEngine({ runtime, folders, idleMs, threads })` runs in plain Node or Electron too, so other projects can use it (Claude-AI's translation is to change).
4. **The runtime**, not bundled into the extension (a native addon): `scripts/copy-runtime.mjs` (last step of `build`) bundles the JavaScript of `onnxruntime-node` into `dist/onnxruntime/lib/index.cjs` (the addon's path left to run time, or esbuild would pull in those of all platforms) and copies the addon and `libonnxruntime.1.dylib` of this machine to `dist/onnxruntime/bin/napi-v6/<platform>/<arch>/`; `loadRuntime` requires it. A VSIX holds the addon of the machine it is packed on, so `scripts/pack.mjs` packs with `vsce --target`. Check native code in the extension host or its binary as Node: `ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)" script.js`.

Texts: `vscode.l10n.t` (English in the code, Russian in `l10n/bundle.l10n.ru.json`; the manifest's in `package.nls*.json`). SCSS in `src/scss/` is compiled by `sass`, then bundled by esbuild into `dist/css/`.

## The engine

- **Models** (`TranslationModel`, `readModelInfo`): a folder with `config.json` (`model_type`: `marian` or `m2m_100`), `tokenizer_config.json`, `vocab.json`, the tokenizer (`source.spm` + `target.spm`, or `sentencepiece.bpe.model`) and ONNX files as optimum exports them (`encoder_model[_quantized].onnx`, `decoder_model_merged[_quantized].onnx`, in `onnx/` or not). Opus-MT does one direction; some name their languages in three letters (`rus`), turned into two. M2M100: the language tokens come after the vocabulary, in the order of `additional_special_tokens` (the same numbers as its `tokenizer.json`), the source's first in the input, the target's forced as the first token generated.
- **`SentencePiece`**: the tokenizer in plain JavaScript — the protobuf of the model, normalization (the precompiled map of `nmt_nfkc`: a Darts double array; whitespace to `▁`) and both algorithms, Unigram (Viterbi; Opus-MT) and BPE (best pairs merged first; M2M100). Not compared with the original library (it is not at hand here): the translations are what shows it right.
- **`Seq2Seq`**: the encoder and the merged decoder (`use_cache_branch`; with a cache the decoder gives no new state of the encoder's attention, the first one stays), a beam search like `transformers` (candidates, finished results by score / length^penalty, `earlyStopping`), the padding of Marian banned, `forcedFirst` for M2M100. `maxLength` is capped by the source length × 3 + 16 against runaway repetition.
- **`TranslatorEngine`**: one job at a time; the language told by `guessLanguage`; `routeTranslation` — Opus-MT for the pair, else a multilingual model, else two models through English; `segmentText` cuts a text into sentences (`Intl.Segmenter`) and keeps everything else exact (line breaks, indentation, spaces, parts without letters; in Markdown code blocks, signs of headings, lists and quotes, table separators; a wrapped paragraph is translated as one and comes out on one line); `protectSpans` hides from the model what it would spoil — code in backticks, addresses, file names, identifiers, flags, in Markdown link addresses and emphasis signs — behind marks `XQ1` (tried against other forms: they pass through all the models; the marks of pairs stand apart from the words). `restoreSpans` puts them back; a mark lost or moved out of order: the words between the spans are translated on their own (worse: Opus-MT makes things up for short fragments). A sentence over 400 tokens is cut at punctuation near its middle. Translations are cached (5000), models loaded on demand (3 kept) and freed after `idleMs`.
- **`TranslationModel.score(text, candidates, from, to)`** (with `Seq2Seq.logProbability`): how well each candidate fits as a translation, the average log-probability per token. Not exposed by the extension: measured on 11 phrases matched to Allow / Deny / Cancel it is right on 9 (Opus-MT) and 7 (M2M100, wrong on all denials), and scores have no usable threshold for "none of these".

## Runtime data flow

- **Catalog** (`modelCatalog.js`): M2M100 (`Xenova/m2m100_418M`, MIT) and 65 pairs of Opus-MT (`Xenova/opus-mt-<pair>`) with the exact bytes and licenses of their files (checked once against Hugging Face; `en-jap` — trained on the Bible —, multi-target and `tc-big` models left out). `TranslationModels.download` writes files as `.part`, renamed when complete, into `<globalStorage>/models/<key>/`; the folder is removed if it fails or is cancelled.
- **No model for a pair**: `suggestDownloads` — the pair of Opus-MT, or both halves through English, or M2M100; the smallest first. The panel shows buttons, the commands a notification. When models turned off could do the pair, it says so and offers no download.
- **Messages**: see the header of `src/panel.js`.

## Icon

`resources/icon.png` (256 px) is made by `swift scripts/make-icon.swift` from `resources/icon-space.svg`, the picture of babylon-editor, tts-stt-aloud, claude-wrapper and bin-editor, with the label TRANSLATOR. `resources/translator.svg` is the icon of the activity bar.

## Ignored files

`dist/`, `node_modules/`, `.vscode/` and `*.vsix` are gitignored (also macOS `.DS_Store` and the `._*` files exFAT volumes get).

## AI Coding Principles

### 1. Study Existing Code and Reuse Analogues

Before implementing a task, carefully study the surrounding environment and existing codebase.
Find similar implementations, analyze them, and use these analogues as a basis for the current task.

If an analogue contains logic errors, does not handle certain edge cases,
or requires changes to be made universal enough to apply to the current task —
always propose fixes to those existing modules as part of the work.

### 2. Think Beyond the Current Task

Do not strictly limit reasoning to the immediate task.
Analyze adjacent modules and the overall project context to anticipate
how the created modules and their functions may be used in similar cases elsewhere.

### 3. Plan Before Complex Implementation

Before implementing a complex task, always create a plan and analyze it thoroughly multiple times.
Only begin implementation after the plan is approved — execute steps one by one,
verifying each step's result and checking for errors and compliance with the plan.

### 4. Prefer Universality Over Narrow Specificity

Sometimes it is worth sacrificing strict specificity and minimalism in favor of universality.
A more universal solution simplifies future use of the module,
allows it to be applied in different situations,
and eliminates code duplication.

### 5. Modular Code Organization

Write code in a modular way, grouping functionality by entity.
This makes code easier to study, remember, apply, and reuse.

- Do not split code into many tiny files.
- Do not overload methods and files with multiple unrelated responsibilities.
- Each logical block must be written as a separate function.

### 6. Anticipate All Behavioral Scenarios

Identify and account for all possible code behavior scenarios depending on incoming data.
Analyze: empty values, unexpected types, unavailable resources, boundary conditions.
Evaluate each scenario against the current task requirements and expected behavior —
not every edge case requires handling, but every case must be consciously considered.

### 7. Scoped Changes and Controlled Refactoring

Only change what is directly necessary for the current task.
Do not refactor unrelated code along the way — unless it is a pattern used by the current task
or inherits from it. In that case, do not silently refactor it either:
propose the fix for discussion and approval before applying.
Do not add unused abstractions "for the future" —
but design the code being written so that it can naturally be reused in future tasks.

### 8. State Assumptions and Uncertainties Explicitly

Never guess silently. If something is assumed rather than confirmed —
state it explicitly before proceeding.
Flag unclear requirements, ambiguous context, or missing information
so that decisions are made consciously, not accidentally.

### 9. Report All Bugs — Fix Only Task-Related Issues

Report every bug discovered; never ignore or fix them silently.
Inside current task: Fix it immediately.
Outside current task: Report it, pause the current task, and wait for a response before proceeding. Do not apply the fix without explicit approval.

### 10. Naming Conventions — Files vs Identifiers

A file is named after its primary export, using that export's casing:
**PascalCase** for classes/components (`components/TranslatorPanel.js`,
`engine/Seq2Seq.js`), **camelCase** for single-function modules
(`utils/createNonce.js`, `engine/segmentText.js`). Files without a single
named primary export (stylesheets, entry points, infrastructure modules) and
folders use **kebab-case** (`scss/panel.scss`).
When in doubt, follow the convention already used in the target directory.
Do not rename existing files just to match this rule.

Identifiers in code (variables, functions, types, components, named exports) use
**PascalCase** for types/components/classes and **camelCase** for variables/functions —
matching their JavaScript semantics.

Conventional uppercase markdown files (`README.md`, `AGENTS.md`, `CLAUDE.md`,
`LICENSE.md`) keep their canonical casing.

### 11. No Comments in SCSS

Do not write comments inside `*.scss` files (no `//` and no `/* */`).
The selector tree itself (`.block { &__elem { ... } }`) is the documentation;
class names follow BEM and CSS variables are self-describing. If a rule needs
explanation, the explanation belongs in the component's JSX/markdown, not the
stylesheet. Move existing helpful notes out when you touch surrounding code.

### 12. Group SCSS Selectors by BEM Prefix

Do not write SCSS as a flat list of sibling selectors. Nest sub-elements
inside their parent block using `&-suffix` chains so each "section" collapses
to a single foldable group in the IDE. Apply to every BEM family
(`&__a`, `&__a-b`, `&__a-c` → nest `&-b` and `&-c` inside `&__a`). Modifiers of
the same element (`&--variant`), pseudo-elements (`&::before`), and descendant
overrides (`.card-header` inside the block) all go inside their owning selector —
never as siblings on the root level.