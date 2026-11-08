import { availableParallelism } from 'node:os';
import * as vscode from 'vscode';
import { SpeechExtension } from './components/SpeechExtension';
import { TextCommands } from './components/TextCommands';
import { Translation } from './components/Translation';
import { TranslationPreview } from './components/TranslationPreview';
import { TranslationModels } from './components/TranslationModels';
import { TranslatorPanel } from './components/TranslatorPanel';
import { TranslatorSettings } from './components/TranslatorSettings';
import { TranslatorEngine } from './engine/TranslatorEngine.js';
import { loadRuntime } from './utils/loadRuntime';

/**
 * @param {import('vscode').ExtensionContext} context
 * @returns {object} the API of the extension for other extensions
 *   (`vscode.extensions.getExtension('ninebits.translator').activate()`)
 */
export function activate(context) {
	const settings = new TranslatorSettings();
	const models = new TranslationModels(context, settings);
	const idleMs = () => settings.get().idleMinutes * 60_000;
	// On the device, with ONNX models: half of the processors, so that the editor stays responsive
	const engine = new TranslatorEngine({
		runtime: () => loadRuntime(context.extensionPath),
		folders: () => settings.activeModels(),
		idleMs: idleMs(),
		threads: Math.max(1, Math.floor(availableParallelism() / 2)),
	});
	let folders = JSON.stringify(settings.activeModels());
	const settingsChanged = settings.onDidChange(() => {
		engine.idleMs = idleMs();
		const now = JSON.stringify(settings.activeModels());
		if (now === folders) return;
		folders = now;
		engine.invalidate();
		engine.release();
	});
	const translation = new Translation(settings, models, engine);
	const speech = new SpeechExtension();
	const panel = new TranslatorPanel(context, settings, translation, speech);
	const preview = new TranslationPreview();
	context.subscriptions.push(settings, models, speech, settingsChanged, panel.register(), preview.register(), new TextCommands(translation, panel, preview).register(), { dispose: () => engine.release() });
	// For other extensions: begins downloading a model of the catalog, gives why it does not ('' : it began)
	context.subscriptions.push(vscode.commands.registerCommand('translator.downloadModel', key => models.download(String(key ?? ''))));
	return {
		/**
		 * @param {string | string[]} input
		 * @param {{ from?: string, to?: string, markdown?: boolean, signal?: AbortSignal }} [options] from: `auto` by default;
		 *   to: the target language of the settings by default
		 * @returns {Promise<string | string[]>} in the form given; rejects with `code: 'NO_MODEL'` when no model can do the pair
		 */
		translate: async (input, options) => {
			const result = await translation.translate(Array.isArray(input) ? input.map(String) : [String(input ?? '')], options ?? {});
			return Array.isArray(input) ? result.texts : result.texts[0];
		},
		/** @returns {string} the language of a text, by its letters */
		detectLanguage: text => engine.detect(String(text ?? '')),
		/** @returns {Promise<boolean>} whether the models installed can translate a pair */
		canTranslate: async (from, to) => !!(await engine.route(from, to)),
		/** Models were added or removed. */
		onDidChangeModels: settings.onDidChange,
	};
}

export function deactivate() {}
