/** The sign of a word boundary in the pieces of SentencePiece. */
const SPACE = '▁';
/** The score given to a character no piece covers (the lowest score minus this), as SentencePiece does. */
const UNKNOWN_PENALTY = 10;
const PIECE_NORMAL = 1;
const PIECE_USER_DEFINED = 4;
const MODEL_UNIGRAM = 1;
const MODEL_BPE = 2;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Reads the fields of a protobuf message.
 * @param {Uint8Array} bytes
 * @param {(field: number, value: number | Uint8Array) => void} visit varints as numbers, the rest as bytes
 */
function readFields(bytes, visit) {
    const varint = (start) => {
        let value = 0;
        let scale = 1;
        let at = start;
        for (;;) {
            const byte = bytes[at++];
            value += (byte & 0x7f) * scale;
            if (byte < 0x80) return [value, at];
            scale *= 128;
        }
    };
    for (let at = 0; at < bytes.length;) {
        const [key, next] = varint(at);
        at = next;
        const field = Math.floor(key / 8), wire = key & 7;
        if (wire === 0) {
            const [value, after] = varint(at);
            at = after;
            visit(field, value);
        } else if (wire === 2) {
            const [length, after] = varint(at);
            visit(field, bytes.subarray(after, after + length));
            at = after + length;
        } else if (wire === 5) {
            visit(field, bytes.subarray(at, at + 4));
            at += 4;
        } else if (wire === 1) {
            visit(field, bytes.subarray(at, at + 8));
            at += 8;
        } else {
            throw new Error(`Unsupported protobuf wire type ${wire}`);
        }
    }
}

/**
 * The longest match in the precompiled character map of a SentencePiece normalizer (a Darts-clone
 * double array over UTF-8 bytes).
 * @param {Uint32Array} units
 * @param {Uint8Array} key
 * @param {number} start
 * @returns {{ value: number, length: number } | null}
 */
function longestMatch(units, key, start) {
    let node = 0;
    let unit = units[0];
    node ^= (unit >>> 10) << ((unit & 0x200) >>> 6);
    let found = null;
    for (let at = start; at < key.length; at++) {
        const byte = key[at];
        if (!byte) break;
        node ^= byte;
        unit = units[node];
        if ((unit & 0x800000ff) >>> 0 !== byte) return found;
        node ^= (unit >>> 10) << ((unit & 0x200) >>> 6);
        if ((unit >>> 8) & 1) found = { value: units[node] & 0x7fffffff, length: at - start + 1 };
    }
    return found;
}

/**
 * @param {Uint8Array} bytes
 * @param {number} at the first byte of a UTF-8 character
 * @returns {number} its length, 0 when the bytes there are not valid UTF-8
 */
function utf8Length(bytes, at) {
    const first = bytes[at];
    const length = first < 0x80 ? 1 : first >= 0xc2 && first < 0xe0 ? 2 : first >= 0xe0 && first < 0xf0 ? 3 : first >= 0xf0 && first < 0xf5 ? 4 : 0;
    if (!length || at + length > bytes.length) return 0;
    for (let i = 1; i < length; i++) if ((bytes[at + i] & 0xc0) !== 0x80) return 0;
    return length;
}

/**
 * A tokenizer of SentencePiece (`.spm`, `.model`) in plain JavaScript, with the results of the
 * original library: its normalization (the precompiled map of `nmt_nfkc`, whitespace to `▁`) and
 * both of its algorithms — Unigram (the likeliest split, Opus-MT) and BPE (the best pairs merged
 * first, M2M100).
 */
export class SentencePiece {

    /**
     * @param {Uint8Array} model the bytes of the model file
     */
    constructor(model) {
        /** @type {Map<string, number>} a piece that can be used -> its score */
        this.scores = new Map();
        this.modelType = MODEL_UNIGRAM;
        this.addDummyPrefix = true;
        this.removeExtraWhitespaces = true;
        this.escapeWhitespaces = true;
        /** @type {Uint32Array | null} */
        this._trie = null;
        /** @type {Uint8Array | null} */
        this._replacements = null;
        readFields(model, (field, value) => {
            if (field === 1) this._readPiece(value);
            else if (field === 2) this._readTrainer(value);
            else if (field === 3) this._readNormalizer(value);
        });
        this._longest = 1;
        let lowest = 0;
        for (const [piece, score] of this.scores) {
            this._longest = Math.max(this._longest, [...piece].length);
            lowest = Math.min(lowest, score);
        }
        this._unknownScore = lowest - UNKNOWN_PENALTY;
    }

    /** @param {Uint8Array} bytes a SentencePiece message */
    _readPiece(bytes) {
        let piece = '';
        let score = 0;
        let type = PIECE_NORMAL;
        readFields(bytes, (field, value) => {
            if (field === 1) piece = decoder.decode(value);
            else if (field === 2) score = new DataView(value.buffer, value.byteOffset, 4).getFloat32(0, true);
            else if (field === 3) type = value;
        });
        if (type === PIECE_NORMAL || type === PIECE_USER_DEFINED) this.scores.set(piece, score);
    }

    /** @param {Uint8Array} bytes a TrainerSpec message */
    _readTrainer(bytes) {
        readFields(bytes, (field, value) => {
            if (field === 3) this.modelType = value;
        });
    }

    /** @param {Uint8Array} bytes a NormalizerSpec message */
    _readNormalizer(bytes) {
        readFields(bytes, (field, value) => {
            if (field === 2) this._readCharsMap(value);
            else if (field === 3) this.addDummyPrefix = !!value;
            else if (field === 4) this.removeExtraWhitespaces = !!value;
            else if (field === 5) this.escapeWhitespaces = !!value;
        });
    }

    /** @param {Uint8Array} blob the size of the double array in bytes, the array, the replacements */
    _readCharsMap(blob) {
        if (blob.length < 4) return;
        const view = new DataView(blob.buffer, blob.byteOffset, blob.length);
        const size = view.getUint32(0, true);
        const trie = new Uint32Array(size / 4);
        for (let i = 0; i < trie.length; i++) trie[i] = view.getUint32(4 + i * 4, true);
        this._trie = trie;
        this._replacements = blob.subarray(4 + size);
    }

    /**
     * @param {Uint8Array} bytes
     * @param {number} at
     * @returns {[Uint8Array, number]} what the text at `at` normalizes to, and how many bytes it takes
     */
    _normalizePrefix(bytes, at) {
        const match = this._trie && longestMatch(this._trie, bytes, at);
        if (match) {
            const start = match.value;
            let end = start;
            while (this._replacements[end]) end++;
            return [this._replacements.subarray(start, end), match.length];
        }
        const length = utf8Length(bytes, at);
        if (!length) return [encoder.encode('�'), 1];
        return [bytes.subarray(at, at + length), length];
    }

    /**
     * @param {string} text
     * @returns {string} normalized as the model was trained: spaces are `▁`
     */
    normalize(text) {
        const bytes = encoder.encode(text);
        const out = [];
        const SPACE_BYTE = 0x20;
        let at = 0;
        if (this.removeExtraWhitespaces) {
            while (at < bytes.length) {
                const [piece, used] = this._normalizePrefix(bytes, at);
                if (piece.length !== 1 || piece[0] !== SPACE_BYTE) break;
                at += used;
            }
        }
        if (at >= bytes.length) return '';
        let previousSpace = this.removeExtraWhitespaces;
        const spaceBytes = encoder.encode(SPACE);
        if (this.addDummyPrefix) out.push(...spaceBytes);
        while (at < bytes.length) {
            const [piece, used] = this._normalizePrefix(bytes, at);
            at += used;
            let start = 0;
            while (previousSpace && start < piece.length && piece[start] === SPACE_BYTE) start++;
            if (start < piece.length) {
                for (let i = start; i < piece.length; i++) {
                    if (this.escapeWhitespaces && piece[i] === SPACE_BYTE) out.push(...spaceBytes);
                    else out.push(piece[i]);
                }
                previousSpace = piece[piece.length - 1] === SPACE_BYTE;
            }
            previousSpace = previousSpace && this.removeExtraWhitespaces;
        }
        let result = decoder.decode(new Uint8Array(out));
        if (this.removeExtraWhitespaces) while (result.endsWith(SPACE)) result = result.slice(0, -SPACE.length);
        return result;
    }

    /**
     * @param {string} text
     * @returns {string[]} its pieces; a part no piece covers comes out as it is (the caller's unknown token)
     */
    encode(text) {
        const normalized = this.normalize(text);
        if (!normalized) return [];
        return this.modelType === MODEL_BPE ? this._encodeBpe(normalized) : this._encodeUnigram(normalized);
    }

    /**
     * @param {string} text normalized
     * @returns {string[]} the likeliest split into pieces (Viterbi over the characters)
     */
    _encodeUnigram(text) {
        const chars = [...text];
        const best = new Array(chars.length + 1).fill(null);
        best[0] = { score: 0, from: -1, known: true };
        for (let start = 0; start < chars.length; start++) {
            const reached = best[start];
            if (!reached) continue;
            let piece = '';
            let single = false;
            for (let end = start + 1; end <= Math.min(chars.length, start + this._longest); end++) {
                piece += chars[end - 1];
                const score = this.scores.get(piece);
                if (score === undefined) continue;
                if (end === start + 1) single = true;
                const total = reached.score + score;
                if (!best[end] || total > best[end].score) best[end] = { score: total, from: start, known: true };
            }
            if (!single) {
                const total = reached.score + this._unknownScore;
                if (!best[start + 1] || total > best[start + 1].score) best[start + 1] = { score: total, from: start, known: false };
            }
        }
        const pieces = [];
        for (let end = chars.length; end > 0; end = best[end].from) pieces.push(chars.slice(best[end].from, end).join(''));
        return pieces.reverse();
    }

    /**
     * @param {string} text normalized
     * @returns {string[]} the characters, the pairs of the best score merged first
     */
    _encodeBpe(text) {
        const symbols = [...text].map((piece, index, all) => ({ piece, previous: index - 1, next: index + 1 < all.length ? index + 1 : -1 }));
        /** @type {{ left: number, right: number, score: number, length: number }[]} */
        const agenda = [];
        const pair = (left, right) => {
            if (left < 0 || right < 0) return;
            const merged = symbols[left].piece + symbols[right].piece;
            const score = this.scores.get(merged);
            if (score !== undefined) agenda.push({ left, right, score, length: merged.length });
        };
        symbols.forEach((symbol, index) => pair(index, symbol.next));
        while (agenda.length) {
            let top = 0;
            for (let i = 1; i < agenda.length; i++) {
                const a = agenda[i], b = agenda[top];
                if (a.score > b.score || (a.score === b.score && a.left < b.left)) top = i;
            }
            const { left, right, length } = agenda[top];
            agenda[top] = agenda[agenda.length - 1];
            agenda.pop();
            const l = symbols[left], r = symbols[right];
            if (!l.piece || !r.piece || l.piece.length + r.piece.length !== length) continue;
            l.piece += r.piece;
            r.piece = '';
            l.next = r.next;
            if (r.next >= 0) symbols[r.next].previous = left;
            pair(l.previous, left);
            pair(left, l.next);
        }
        return symbols.filter(symbol => symbol.piece).map(symbol => symbol.piece);
    }

    /**
     * @param {string[]} pieces
     * @returns {string} the text they make
     */
    static decode(pieces) {
        return pieces.join('').replaceAll(SPACE, ' ').replace(/^ /, '');
    }
}
