// utils/llmSecurity/relevanceFilter.js

/**
 * Summary-based Relevance Filter
 * 
 * DESIGN PHILOSOPHY:
 * The meeting summary is the GROUND TRUTH for what's relevant.
 * We use it to guide the LLM, not to rigidly block queries.
 * 
 * This filter is LENIENT by design:
 * - Short queries always pass (give user benefit of doubt)
 * - Meta-questions about the meeting always pass
 * - We only block clearly off-topic queries
 * - When in doubt, let the LLM + hardened prompt handle it
 */

const { getMeetingSummary } = require('../../db/mongoutils/summary.db');

// Common stop words to ignore in keyword extraction
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

/**
 * Extracts meaningful keywords from text
 */
function extractKeywords(text) {
    if (!text) return [];

    return text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(word => word.length > 2 && !STOP_WORDS.has(word));
}

/**
 * Checks if query matches always-allowed patterns
 */
function isMetaQuery(query) {
    return ALWAYS_ALLOWED_PATTERNS.some(pattern => pattern.test(query.trim()));
}

/**
 * Determines if a user query is relevant to the meeting content
 * 
 * LENIENT BY DESIGN - when in doubt, we let the query through
 * and rely on the hardened system prompt to keep the LLM on topic.
 * 
 * @param {string} userQuery - The user's question
 * @param {string} jobId - The meeting job ID
 * @returns {Promise<Object>} { relevant: boolean, reason: string, message?: string }
 */
async function isRelevantToMeeting(userQuery, jobId) {
    // Always allow meta-questions about the meeting
    if (isMetaQuery(userQuery)) {
        return { relevant: true, reason: 'meta_query' };
    }

    try {
        const summary = await getMeetingSummary(jobId);

        // No summary yet - meeting just started, allow everything
        if (!summary || !summary.content) {
            return { relevant: true, reason: 'no_summary_yet' };
        }

        // Extract keywords from query and summary
        const queryKeywords = extractKeywords(userQuery);
        const summaryKeywords = extractKeywords(summary.content + ' ' + (summary.title || ''));

        // Very short queries (1-3 keywords) - be lenient, let through
        if (queryKeywords.length <= 3) {
            return { relevant: true, reason: 'short_query' };
        }

        // Find overlapping keywords
        const overlap = queryKeywords.filter(word => summaryKeywords.includes(word));

        // Require at least 1 matching keyword OR 10% overlap
        // This is VERY lenient - only blocks clearly unrelated queries
        if (overlap.length >= 1 || queryKeywords.length === 0) {
            return {
                relevant: true,
                reason: 'keyword_match',
                matchedKeywords: overlap
            };
        }

        // No match at all - likely completely off-topic
        // But even here, we use a soft rejection that guides the user
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
