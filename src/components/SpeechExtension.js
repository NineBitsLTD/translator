import * as vscode from 'vscode';

/** The extension that speaks and listens; optional: without it the side bar has no such buttons. */
const EXTENSION_ID = 'ninebits.tts-stt-aloud';
/** The lowest among the windows of VS Code: any other speech goes first, as with reading a file aloud. */
const SPEECH_PRIORITY = 0;
/** One phrase to translate: 10 s for it to begin, a minute at most, ended by a pause of 1 s. */
const RECORD_LIMITS = { waitMs: 10_000, maxMs: 60_000, silenceMs: 1_000 };

/**
 * @param {any} error
 * @returns {{ error: string }} for showing
 */
function failure(error) {
    return { error: error?.message ?? String(error) };
}

/**
 * @param {string | null | undefined} text recognized
 * @returns {string} the words of it ('' : none; Whisper names what it hears without words: [Music], (шум))
 */
function wordsOf(text) {
    const heard = text?.trim() ?? '';
    return /[\p{L}\p{N}]/u.test(heard) && !/^[[(].*[\])]$/.test(heard) ? heard : '';
}

/**
 * Speaks and records through the extension TTS / STT Aloud, when it is there. Its voices, its
 * microphone and the language it recognizes are those of its own settings.
 */
export class SpeechExtension {

    constructor() {
        /** @type {vscode.EventEmitter<void>} */
        this._changed = new vscode.EventEmitter();
        /** The extension was installed or removed. */
        this.onDidChange = this._changed.event;
        this._wasFound = this.found;
        this._subscription = vscode.extensions.onDidChange(() => {
            if (this.found === this._wasFound) return;
            this._wasFound = this.found;
            this._changed.fire();
        });
        // The API has one owner for all extensions: what is stopped here must have been asked for here
        this._speeches = 0;
        this._recordings = 0;
    }

    dispose() {
        this._subscription.dispose();
        this._changed.dispose();
    }

    /** @returns {boolean} whether the extension is installed and enabled */
    get found() {
        return !!vscode.extensions.getExtension(EXTENSION_ID);
    }

    /**
     * @returns {Promise<any>} the API of the extension
     * @throws {Error} when it is gone
     */
    async _api() {
        const extension = vscode.extensions.getExtension(EXTENSION_ID);
        if (!extension) throw new Error(vscode.l10n.t('The extension TTS / STT Aloud is not installed.'));
        return extension.activate();
    }

    /**
     * Speaks a text; a new speech ends the one being spoken.
     * @param {string} text
     * @param {string} lang its language, to choose the voice by
     * @returns {Promise<{ error?: string }>} when it has ended, or why it could not begin
     */
    async speak(text, lang) {
        this._speeches++;
        try {
            const api = await this._api();
            if (!api.settings().tts.enabled) return { error: vscode.l10n.t('Text to speech is off: turn TTS on in the TTS / STT side bar.') };
            await api.tts.speak(text, { lang, priority: SPEECH_PRIORITY });
            return {};
        } catch (error) {
            return failure(error);
        } finally {
            this._speeches--;
        }
    }

    /** Ends the speech asked for here. */
    stopSpeaking() {
        if (this._speeches) vscode.extensions.getExtension(EXTENSION_ID)?.exports?.tts.stop();
    }

    /**
     * Records a phrase from the microphone and recognizes it.
     * @returns {Promise<{ text?: string, error?: string }>} text: '' when no words were heard
     */
    async record() {
        this._recordings++;
        try {
            const api = await this._api();
            // The microphone would hear the speech
            this.stopSpeaking();
            const { text, error } = await api.stt.record(RECORD_LIMITS);
            return error ? { error } : { text: wordsOf(text) };
        } catch (error) {
            return failure(error);
        } finally {
            this._recordings--;
        }
    }

    /** Ends the recording asked for here: what was said so far is still recognized. */
    stopRecording() {
        if (this._recordings) vscode.extensions.getExtension(EXTENSION_ID)?.exports?.stt.stop();
    }
}
