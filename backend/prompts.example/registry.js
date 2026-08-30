// Placeholder registry with the real one's interface: getPrompt(task, context) resolving a variant
// from context.hasSpeakers, falling back to `default`. See README.md in this directory.
const prompts = {
    clean: {
        default: 'Clean up this transcript.',
        diarized: 'Clean up this transcript, preserving speaker labels.',
    },
    // Summary variants are template FUNCTIONS, not strings: summary.service.js calls the resolved
    // value with (currentSummary, newTranscript, wordLimit) and rejects anything else.
    summary: {
        default: (previousSummary, newTranscript, wordLimit) =>
            `Summarise this meeting in under ${wordLimit} words.\n\nSo far:\n${previousSummary || '(none)'}\n\nNew:\n${newTranscript}`,
        'speaker-aware': (previousSummary, newTranscript, wordLimit) =>
            `Summarise this meeting in under ${wordLimit} words, attributing points to speakers.\n\nSo far:\n${previousSummary || '(none)'}\n\nNew:\n${newTranscript}`,
    },
};

function getPrompt(task, context = {}) {
    const taskPrompts = prompts[task];
    if (!taskPrompts) return prompts.clean.default;

    if (context.hasSpeakers) {
        if (task === 'clean' && taskPrompts.diarized) return taskPrompts.diarized;
        if (task === 'summary' && taskPrompts['speaker-aware']) return taskPrompts['speaker-aware'];
    }
    return taskPrompts.default;
}

module.exports = { getPrompt };
