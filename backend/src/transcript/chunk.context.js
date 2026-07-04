// Builds the situating context prepended to a chunk before it is embedded and indexed.
// A bare chunk retrieves badly with no idea where it sits, so meeting/time/speaker context
// goes into both the dense embedding and BM25 index. Layer 1 uses a free template; layer 2 reuses its LLM rewrite.

'use strict';

const MAX_SPEAKERS_LISTED = 4;

function formatClock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function formatSpeakers(speakers = []) {
    const named = speakers.filter(Boolean);
    if (!named.length) return null;
    if (named.length <= MAX_SPEAKERS_LISTED) return named.join(', ');
    return `${named.slice(0, MAX_SPEAKERS_LISTED).join(', ')} +${named.length - MAX_SPEAKERS_LISTED} more`;
}

/**
 * Deterministic context for a verbatim (layer 1) chunk.
 *
 * @param {object} chunk    { t0Ms, t1Ms, speakers, hasOverlap }
 * @param {object} [meeting] { title, topic }  topic is the enclosing L3 node when one exists
 * @returns {string} e.g. "[Q3 planning | 12:30–14:05 | Topic: pricing | Speakers: S1, S2 | overlapping speech]"
 */
function buildContextPrefix(chunk, meeting = {}) {
    const parts = [];

    if (meeting.title) parts.push(meeting.title);
    parts.push(`${formatClock(chunk.t0Ms)}–${formatClock(chunk.t1Ms)}`);
    if (meeting.topic) parts.push(`Topic: ${meeting.topic}`);

    const speakers = formatSpeakers(chunk.speakers);
    if (speakers) parts.push(`Speakers: ${speakers}`);

    // Carried into retrieval so an answer drawn from contested audio can be hedged.
    if (chunk.hasOverlap) parts.push('overlapping speech');

    return `[${parts.join(' | ')}]`;
}

/** What actually gets embedded and indexed: prefix first, then the chunk text. */
function withContext(chunk, meeting = {}) {
    const prefix = chunk.contextPrefix || buildContextPrefix(chunk, meeting);
    return `${prefix}\n${chunk.text}`;
}

module.exports = { buildContextPrefix, withContext, formatClock, formatSpeakers };
