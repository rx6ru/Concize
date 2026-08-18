

/**
 * Summary-based relevance filter. The meeting summary guides the LLM; it is not used to rigidly block queries.
 * Lenient by design: short queries and meta-questions about the meeting always pass, and only clearly off-topic queries are blocked.
 */

const { getMeetingSummary } = require('../summary/summary.repository');

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'up',
    'about', 'into', 'over', 'after', 'beneath', 'under', 'above',
    'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
    'she', 'we', 'they', 'what', 'which', 'who', 'whom', 'whose',
    'where', 'when', 'why', 'how', 'all', 'each', 'every', 'both',
    'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not',
    'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just', 'and',
    'but', 'if', 'or', 'because', 'as', 'until', 'while', 'although',
    'meeting', 'discussed', 'said', 'mentioned', 'talked', 'about',
    'please', 'tell', 'me', 'can', 'could', 'would', 'like', 'want'
]);

// Always-allowed queries (meta-questions about the meeting itself)
const ALWAYS_ALLOWED_PATTERNS = [
    /^what (was|is|were) (this|the) meeting about/i,
    /^summarize/i,
    /^summary/i,
    /^what happened/i,
    /^give me a (summary|recap|overview)/i,
    /^who (attended|was there|participated)/i,
    /^when (was|did) (this|the) meeting/i,
    /^what did (we|they|you) (discuss|talk about|cover)/i,
    /^key (points|takeaways|decisions)/i,
    /^action items/i,
    /^next steps/i,
];

function extractKeywords(text) {
    if (!text) return [];

    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2 && !STOP_WORDS.has(word));
}

function isMetaQuery(query) {
    return ALWAYS_ALLOWED_PATTERNS.some(pattern => pattern.test(query.trim()));
}

/**
 * Determines if a user query is relevant to the meeting content. Lenient by design: when in doubt, the query passes through and the hardened system prompt keeps the LLM on topic.
 * @param {string} userQuery
 * @param {string} jobId
 * @returns {Promise<Object>} { relevant: boolean, reason: string, message?: string }
 */
async function isRelevantToMeeting(userQuery, jobId) {
    if (isMetaQuery(userQuery)) {
        return { relevant: true, reason: 'meta_query' };
    }

    try {
        const summary = await getMeetingSummary(jobId);

        if (!summary || !summary.content) {
            return { relevant: true, reason: 'no_summary_yet' };
        }

        const queryKeywords = extractKeywords(userQuery);
        const summaryKeywords = extractKeywords(summary.content + ' ' + (summary.title || ''));

        if (queryKeywords.length <= 3) {
            return { relevant: true, reason: 'short_query' };
        }

        const overlap = queryKeywords.filter(word => summaryKeywords.includes(word));

        if (overlap.length >= 1 || queryKeywords.length === 0) {
            return {
                relevant: true,
                reason: 'keyword_match',
                matchedKeywords: overlap
            };
        }

        // Soft rejection: guides the user rather than a hard block.
        console.log(`RELEVANCE_FILTER: Low relevance for job ${jobId}. Query: "${userQuery.substring(0, 50)}..."`);
        return {
            relevant: false,
            reason: 'off_topic',
            message: "I couldn't find a connection to this meeting. Could you rephrase your question or ask about something that was discussed?"
        };

    } catch (error) {
        console.error('RELEVANCE_FILTER_ERROR:', error);
        // On error, always allow (fail open for usability)
        return { relevant: true, reason: 'error_fallback' };
    }
}

module.exports = {
    isRelevantToMeeting,
    extractKeywords,
    isMetaQuery
};
