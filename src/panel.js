import { HostRequests } from './panel/HostRequests.js';
import { TranslatorView } from './panel/TranslatorView.js';

/**
 * The webview of the side bar (`TranslatorPanel` on the host). Messages: host → webview `init`
 * (texts), `state` (languages, models), `progress` (a download), `translating`, `translateText`,
 * `hostReply`; webview → host `ready`, `languages`, `cancel`, `copy`, `download`, `modelActive`,
 * `remove`, `reveal`, `stopSpeaking`, `stopRecording`, and the requests `translate`, `selection`, `clipboard`, `replace`,
 * `speak`, `record`, `browseFolder`, `addModel`.
 */
const vscode = acquireVsCodeApi();
const host = new HostRequests(message => vscode.postMessage(message));
/** @type {TranslatorView | null} */
let view = null;

window.addEventListener('message', (event) => {
    const message = event.data;
    if (host.handleMessage(message)) return;
    if (message?.type === 'init') {
        view = new TranslatorView(/** @type {HTMLElement} */ (document.querySelector('.tr')), host, message.strings);
        return;
    }
    if (!view) return;
    switch (message?.type) {
        case 'state': view.setState(message); break;
        case 'progress': view.setDownload(message.key, message.done, message.total); break;
        case 'translating': view.setWorking(message.done, message.total); break;
        case 'translateText': view.translateText(message.text, message.markdown); break;
    }
});
vscode.postMessage({ type: 'ready' });
