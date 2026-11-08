# Translator

A Visual Studio Code extension that translates text on your device with ONNX models. Nothing leaves the computer except the download of the models themselves.

## Features

- **Side bar** — languages (or Auto), the text and its translation; **Selection** and **Clipboard** take the text and translate it; **Copy**, **Replace selection**. With the extension TTS / STT Aloud (`ninebits.tts-stt-aloud`) installed, buttons read the text or its translation aloud (at the lowest priority among the windows of VS Code) and record speech to translate (STT must be on there).
- **Editor commands** — **Translate Selection**, **Replace Selection with Translation** (also in the context menu), **Translate Clipboard**, **Translate File into a New Editor**.
- **Models** — download them in the side bar, with progress: **Opus-MT** (about 110 MB, one direction: en→ru, ru→en, en→uk…, 65 pairs) or **M2M100** (about 610 MB, every pair of 100 languages), or use a model folder on your disk. A pair with no direct model goes through English when both halves are installed. The check box next to a model turns it on or off for translating.
- **Keeps what should not be translated** — line breaks and indentation, code in backticks, addresses, file names and identifiers; in Markdown also code blocks, headings and lists, links and emphasis.
- **For other extensions** — `vscode.extensions.getExtension('ninebits.translator').activate()` gives `translate(textOrTexts, { from, to, markdown })`, `detectLanguage(text)`, `canTranslate(from, to)`; the command `translator.translate` does the same.

## Requirements

- Visual Studio Code `^1.107.0`
- Node.js (with `npm`) to build and package the extension from source

## Getting started (development)

The entry point is the **bundled** output in `dist/`, not `src/`, so build before launching.

```bash
npm install
npm run watch      # build once, then rebuild on change
npm test           # logic; with TRANSLATOR_TEST_MODELS=<folder> also the real models
```

Then press **F5** with a "Run Extension" configuration (`"type": "extensionHost"`, `"args": ["--extensionDevelopmentPath=${workspaceFolder}"]`).

## Packaging and installing

```bash
npm install
npm run pack       # packs translator-<platform>-<arch>-<version>.vsix for this machine
code --install-extension translator-darwin-arm64-1.1.0.vsix
```

## License

MIT — see the `LICENSE` file. The models and the runtime have their own licenses: `THIRD-PARTY-NOTICES.md`.
