// Placeholder. The real summary prompt is not published; see README.md in this directory.
// Signature matches the real one: previous summary, new transcript, and a word budget.
const getSummaryPrompt = (previousSummary, newTranscript, wordLimit) => `
Update the meeting summary using the new transcript. Keep it under ${wordLimit} words.

Current summary:
${previousSummary || '(none yet)'}

New transcript:
${newTranscript}
`.trim();

module.exports = {
    getSummaryPrompt,
};
