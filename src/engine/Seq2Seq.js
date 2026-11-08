/** A step's candidates per beam kept for the search, as a multiple of the beams. */
const CANDIDATES_PER_BEAM = 2;

/**
 * @typedef {object} GenerateOptions
 * @property {number} start the token the decoder starts from
 * @property {number} eos the token that ends the text
 * @property {number[]} [banned] tokens never generated (the padding of Marian)
 * @property {number} [forcedFirst] the first token generated (the language of M2M100)
 * @property {number} [beams] the width of the beam search (1: greedy)
 * @property {number} maxLength the longest result in tokens
 * @property {boolean} [earlyStopping] stop once `beams` results are finished
 * @property {number} [lengthPenalty] a finished result's score is divided by its length to this power
 * @property {AbortSignal} [signal]
 */

/**
 * @param {Float32Array} row the logits of one beam
 * @param {number[]} banned
 * @param {number} [forced] the only token allowed
 * @returns {Float64Array} log-probabilities
 */
function logSoftmax(row, banned, forced) {
    const out = new Float64Array(row.length);
    if (forced !== undefined) {
        out.fill(-Infinity);
        out[forced] = 0;
        return out;
    }
    let max = -Infinity;
    for (let i = 0; i < row.length; i++) if (row[i] > max) max = row[i];
    let sum = 0;
    for (let i = 0; i < row.length; i++) {
        out[i] = row[i];
        sum += Math.exp(row[i] - max);
    }
    for (const token of banned) {
        sum -= Math.exp(out[token] - max);
        out[token] = -Infinity;
    }
    const shift = max + Math.log(sum);
    for (let i = 0; i < out.length; i++) out[i] -= shift;
    return out;
}

/**
 * @param {Float64Array} scores
 * @param {number} count
 * @returns {number[]} the indices of the highest scores
 */
function topIndices(scores, count) {
    const top = [];
    for (let i = 0; i < scores.length; i++) {
        const score = scores[i];
        if (score === -Infinity) continue;
        if (top.length === count && score <= scores[top[count - 1]]) continue;
        let at = top.length;
        while (at > 0 && scores[top[at - 1]] < score) at--;
        top.splice(at, 0, i);
        if (top.length > count) top.pop();
    }
    return top;
}

/**
 * An encoder-decoder model of ONNX (`encoder_model*.onnx`, `decoder_model_merged*.onnx` as optimum
 * exports them) with its own beam search, the way `transformers` generates: the decoder runs one
 * token at a time over its cached state, which is reordered as the beams change.
 */
export class Seq2Seq {

    /**
     * @param {typeof import('onnxruntime-node')} ort
     * @param {string} encoderPath
     * @param {string} decoderPath
     * @param {{ heads: number, dimension: number, threads?: number }} options
     * @returns {Promise<Seq2Seq>}
     */
    static async load(ort, encoderPath, decoderPath, { heads, dimension, threads }) {
        const session = { executionProviders: ['cpu'], graphOptimizationLevel: 'all', ...(threads ? { intraOpNumThreads: threads } : {}) };
        const [encoder, decoder] = await Promise.all([ort.InferenceSession.create(encoderPath, session), ort.InferenceSession.create(decoderPath, session)]);
        return new Seq2Seq(ort, encoder, decoder, heads, dimension);
    }

    constructor(ort, encoder, decoder, heads, dimension) {
        this._ort = ort;
        this._encoder = encoder;
        this._decoder = decoder;
        this._heads = heads;
        this._keySize = dimension / heads;
        this._pastNames = decoder.inputNames.filter(name => name.startsWith('past_key_values'));
    }

    async release() {
        await Promise.all([this._encoder.release(), this._decoder.release()]);
    }

    /**
     * @param {number[]} ids
     * @returns {BigInt64Array}
     */
    static _int64(ids) {
        return BigInt64Array.from(ids, BigInt);
    }

    /**
     * @param {number[]} ids the source tokens
     * @returns {Promise<{ hidden: any, mask: any }>}
     */
    async _encode(ids) {
        const mask = new this._ort.Tensor('int64', new BigInt64Array(ids.length).fill(1n), [1, ids.length]);
        const input = new this._ort.Tensor('int64', Seq2Seq._int64(ids), [1, ids.length]);
        const out = await this._encoder.run({ input_ids: input, attention_mask: mask });
        return { hidden: out.last_hidden_state, mask };
    }

    /**
     * @param {any} tensor its first dimension is the beams
     * @param {number[]} rows the beams to keep, in their new order
     * @returns {any} a tensor of those rows
     */
    _select(tensor, rows) {
        const size = tensor.dims.slice(1).reduce((a, b) => a * b, 1);
        const data = new tensor.data.constructor(rows.length * size);
        rows.forEach((row, index) => data.set(tensor.data.subarray(row * size, (row + 1) * size), index * size));
        return new this._ort.Tensor(tensor.type, data, [rows.length, ...tensor.dims.slice(1)]);
    }

    /**
     * One token of every beam through the decoder.
     * @param {number[]} tokens the last token of each beam
     * @param {{ hidden: any, mask: any }} encoded for each beam
     * @param {Record<string, any> | null} past
     * @returns {Promise<{ logits: any, past: Record<string, any> }>}
     */
    async _step(tokens, encoded, past) {
        const beams = tokens.length;
        const { Tensor } = this._ort;
        const feeds = {
            input_ids: new Tensor('int64', Seq2Seq._int64(tokens), [beams, 1]),
            encoder_hidden_states: encoded.hidden,
            encoder_attention_mask: encoded.mask,
            use_cache_branch: new Tensor('bool', [!!past], [1]),
        };
        for (const name of this._pastNames) feeds[name] = past ? past[name] : new Tensor('float32', new Float32Array(0), [beams, this._heads, 0, this._keySize]);
        const out = await this._decoder.run(feeds);
        const next = {};
        for (const name of this._pastNames) {
            // With a cache the decoder gives no new state of the encoder's attention: the first one stays
            next[name] = past && name.includes('.encoder.') ? past[name] : out[name.replace('past_key_values', 'present')];
        }
        return { logits: out.logits, past: next };
    }

    /**
     * @param {number[]} ids the source tokens
     * @param {GenerateOptions} options
     * @returns {Promise<number[]>} the best result, without the final end token
     */
    async generate(ids, { start, eos, banned = [], forcedFirst, beams = 1, maxLength, earlyStopping = false, lengthPenalty = 1, signal }) {
        const source = await this._encode(ids);
        const encodedFor = (count) => ({ hidden: this._select(source.hidden, new Array(count).fill(0)), mask: this._select(source.mask, new Array(count).fill(0)) });
        const normalized = (score, length) => score / length ** lengthPenalty;
        /** @type {{ tokens: number[], score: number }[]} */
        let live = [{ tokens: [start], score: 0 }];
        /** @type {{ tokens: number[], score: number }[]} */
        const finished = [];
        let past = null;
        let encoded = encodedFor(1);
        for (let length = 1; length <= maxLength; length++) {
            signal?.throwIfAborted();
            const step = await this._step(live.map(beam => beam.tokens[beam.tokens.length - 1]), encoded, past);
            const vocabulary = step.logits.dims[2];
            const lengthOfLogits = step.logits.dims[1];
            const candidates = [];
            live.forEach((beam, row) => {
                const from = (row + 1) * lengthOfLogits * vocabulary - vocabulary;
                const log = logSoftmax(step.logits.data.subarray(from, from + vocabulary), banned, length === 1 ? forcedFirst : undefined);
                for (const token of topIndices(log, beams * CANDIDATES_PER_BEAM)) candidates.push({ row, token, score: beam.score + log[token] });
            });
            candidates.sort((a, b) => b.score - a.score);
            const next = [];
            const rows = [];
            for (const candidate of candidates) {
                if (next.length === beams) break;
                const tokens = [...live[candidate.row].tokens, candidate.token];
                if (candidate.token === eos) finished.push({ tokens: tokens.slice(1, -1), score: normalized(candidate.score, tokens.length - 1) });
                else {
                    next.push({ tokens, score: candidate.score });
                    rows.push(candidate.row);
                }
            }
            finished.sort((a, b) => b.score - a.score);
            finished.splice(beams);
            if (!next.length) break;
            if (finished.length === beams && (earlyStopping || normalized(next[0].score, length + 1) < finished[beams - 1].score)) break;
            const same = rows.length === live.length && rows.every((row, index) => row === index);
            past = step.past;
            if (!same) for (const name of this._pastNames) past[name] = this._select(past[name], rows);
            if (rows.length !== live.length) encoded = encodedFor(rows.length);
            live = next;
        }
        const best = finished[0] ?? { tokens: live[0].tokens.slice(1) };
        return best.tokens;
    }

    /**
     * How likely the model finds a given result for a source (no search: the decoder is fed the result).
     * @param {number[]} ids the source tokens
     * @param {number[]} target the tokens of the result, the end token included
     * @param {{ start: number, banned?: number[], skip?: number }} options skip: leading tokens of the target
     *   that are not scored (the language of M2M100)
     * @returns {Promise<number>} the sum of the log-probabilities of its tokens
     */
    async logProbability(ids, target, { start, banned = [], skip = 0 }) {
        const encoded = await this._encode(ids);
        let past = null;
        let sum = 0;
        let last = start;
        for (let at = 0; at < target.length; at++) {
            const step = await this._step([last], encoded, past);
            past = step.past;
            const vocabulary = step.logits.dims[2];
            const from = step.logits.data.length - vocabulary;
            if (at >= skip) sum += logSoftmax(step.logits.data.subarray(from, from + vocabulary), banned)[target[at]];
            last = target[at];
        }
        return sum;
    }
}
