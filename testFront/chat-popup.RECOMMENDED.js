class ChatInterface {
    constructor() {
        this.messagesContainer = document.getElementById('chatMessages');
        this.messageInput = document.getElementById('messageInput');
        this.sendButton = document.getElementById('sendButton');
        this.errorMessage = document.getElementById('errorMessage');
        this.scrollToBottomBtn = document.getElementById('scrollToBottomBtn');

        this.chatContainer = document.querySelector('.chat-container');
        this.closeButton = document.getElementById('closeButton');
        this.isStreaming = false;
        this.currentStreamingMessage = null;
        this.chatHistory = [];

        this.init();
    }

    init() {

        this.sendButton.addEventListener('click', () => this.sendMessage());
        this.closeButton.addEventListener('click', () => window.close());
        this.messageInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        // Auto-resize textarea
        this.messageInput.addEventListener('input', () => {
            this.messageInput.style.height = 'auto';
            this.messageInput.style.height = Math.min(this.messageInput.scrollHeight, 100) + 'px';
        });

        // Scroll to bottom button
        this.messagesContainer.addEventListener('scroll', () => {
            const isAtBottom = this.messagesContainer.scrollHeight - this.messagesContainer.scrollTop <= this.messagesContainer.clientHeight + 1; // Add a 1px tolerance
            this.scrollToBottomBtn.classList.toggle('hidden', isAtBottom);
        });

        this.scrollToBottomBtn.addEventListener('click', () => {
            this.scrollToBottom();
        });


    }

    showError(message) {
        this.errorMessage.textContent = message;
        this.errorMessage.style.display = 'block';
        setTimeout(() => {
            this.errorMessage.style.display = 'none';
        }, 5000);
    }

    // --- SECURITY: HTML ESCAPE HELPER ---
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // --- MAIN SEND LOGIC ---
    async sendMessage() {
        const message = this.messageInput.value.trim();
        if (!message || this.isStreaming) return;

        this.clearEmptyState();
        this.addMessage(message, 'user');
        this.chatHistory.push({ role: 'user', content: message });

        this.messageInput.value = '';
        this.messageInput.style.height = 'auto';
        this.setStreamingState(true);

        try {
            await this.streamBotResponse(message);
        } catch (error) {
            console.error('Logic Error caught in sendMessage:', error);
            // NB: Most specific errors are now handled inside streamBotResponse (ui updated there)
            // This catch handles critical failures (like network down before fetch)
            if (!this.currentStreamingMessage) {
                this.addMessage('Sorry, I encountered a connection error. Please try again.', 'bot');
            }
        } finally {
            this.setStreamingState(false);
        }
    }

    clearEmptyState() {
        const emptyState = this.messagesContainer.querySelector('.empty-state');
        if (emptyState) {
            emptyState.remove();
        }
    }

    addMessage(content, type) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${type}`;

        const bubbleDiv = document.createElement('div');
        bubbleDiv.className = 'message-bubble';

        if (type === 'bot') {
            const contentDiv = document.createElement('div');
            contentDiv.innerHTML = marked.parse(content);
            bubbleDiv.appendChild(contentDiv);

            if (!content.includes('Sorry, I encountered an error.')) {
                const copyBtn = this.createCopyButton(content);
                bubbleDiv.appendChild(copyBtn);
            }
        } else {
            bubbleDiv.textContent = content;
        }

        messageDiv.appendChild(bubbleDiv);
        this.messagesContainer.appendChild(messageDiv);
        this.scrollToBottom();

        return bubbleDiv;
    }

    createCopyButton(textToCopy) {
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';

        const copyIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
        const tickIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>`;

        copyBtn.innerHTML = copyIcon;

        copyBtn.addEventListener('click', async () => {
            copyBtn.disabled = true;
            try {
                await navigator.clipboard.writeText(textToCopy);
                copyBtn.innerHTML = tickIcon;
                copyBtn.classList.add('copy-success');
                setTimeout(() => {
                    copyBtn.innerHTML = copyIcon;
                    copyBtn.classList.remove('copy-success');
                    copyBtn.disabled = false;
                }, 2000);
            } catch (err) {
                console.error('Failed to copy text: ', err);
                copyBtn.disabled = false;
            }
        });
        return copyBtn;
    }

    // --- ROBUST ERROR HANDLING STREAM LOGIC ---
    async streamBotResponse(userMessage) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message bot';
        const bubbleDiv = document.createElement('div');
        bubbleDiv.className = 'message-bubble';

        // 1. Setup Loading Indicator
        const indicator = document.createElement('div');
        indicator.className = 'streaming-indicator';
        indicator.innerHTML = 'Processing<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>';

        bubbleDiv.appendChild(indicator);
        messageDiv.appendChild(bubbleDiv);
        this.messagesContainer.appendChild(messageDiv);
        this.currentStreamingMessage = bubbleDiv;
        this.scrollToBottom();

        const API_URL = 'http://localhost:3000/api/chat/stream';
        let accumulatedText = '';
        
        try {
            const result = await chrome.storage.local.get('jobId');
            const jobId = result.jobId;

            const response = await fetch(API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-auth-code': 'lostnfound'
                },
                body: JSON.stringify({
                    userPrompt: userMessage,
                    jobId: jobId || "default",
                })
            });

            // --- ERROR CHECK 1: PRE-STREAM HTTP ERRORS (429, 503, 500) ---
            if (!response.ok) {
                let errorMessage = `Server Error (${response.status})`;
                try {
                    const errorData = await response.json();
                    if (errorData.error && errorData.error.message) {
                        errorMessage = errorData.error.message;
                    }
                } catch (parseErr) {
                    console.warn("Failed to parse error JSON:", parseErr);
                }

                // Remove loading indicator immediately
                indicator.remove();

                // Display Error IN BUBBLE as requested
                // Using simple HTML styling for error visibility
                bubbleDiv.innerHTML = `<div style="color: #ff6b6b; font-weight: 500;">
                    ⚠️ ${this.escapeHtml(errorMessage)}
                </div>`;

                // Throwing here stops further execution (goes to catch, but bubble is already handled)
                throw new Error(errorMessage);
            }

            // --- STREAMING PHASE ---
            const reader = response.body.getReader();
            const decoder = new TextDecoder();

            let indicatorRemoved = false;
            let isErrorEvent = false; // Flag for multi-line SSE events

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunk = decoder.decode(value, { stream: true });
                    const lines = chunk.split('\n');

                    for (const line of lines) {
                        const trimmedLine = line.trim();
                        if (!trimmedLine) continue;

                        // --- ERROR CHECK 2: MID-STREAM SSE ERRORS ---
                        if (trimmedLine.startsWith('event: error')) {
                            isErrorEvent = true;
                            continue;
                        }

                        if (trimmedLine.startsWith('data: ')) {
                            const jsonStr = trimmedLine.slice(6);

                            try {
                                const jsonData = JSON.parse(jsonStr);

                                // Handle Error Data (Subsequent line to event: error)
                                if (isErrorEvent) {
                                    const errMsg = jsonData.message || "Stream interrupted.";

                                    if (!indicatorRemoved) { indicator.remove(); indicatorRemoved = true; }

                                    // Append Error to existing text (if any)
                                    // This preserves partial correct answer before the error occurred
                                    const errorHtml = `<br><br><div style="border-top: 1px solid rgba(255,255,255,0.2); margin-top: 8px; padding-top: 8px; color: #ff6b6b; font-size: 0.9em;">
                                        ⚠️ <b>Connection Lost:</b> ${this.escapeHtml(errMsg)}
                                    </div>`;

                                    bubbleDiv.innerHTML = marked.parse(accumulatedText) + errorHtml;
                                    isErrorEvent = false; // Reset flag
                                    return; // Stop processing
                                }

                                // Handle Standard Text
                                if (jsonData.event === 'stream_end') {
                                    break;
                                } else if (jsonData.text) {
                                    if (!indicatorRemoved) {
                                        indicator.remove();
                                        indicatorRemoved = true;
                                    }
                                    accumulatedText += jsonData.text;
                                    bubbleDiv.innerHTML = marked.parse(accumulatedText);
                                    this.scrollToBottom();

                                    // Optional: throttled scroll could replace the timeout loop if preferred
                                }
                            } catch (e) {
                                console.warn('Failed to parse JSON line:', trimmedLine, e);
                            }
                        }
                    }
                }
            } catch (streamError) {
                // Handle Network Interruption mid-read
                if (!indicatorRemoved) { indicator.remove(); indicatorRemoved = true; }
                const errorHtml = `<br><br><div style="border-top: 1px solid rgba(255,255,255,0.2); margin-top: 8px; padding-top: 8px; color: #ff6b6b; font-size: 0.9em;">
                    ⚠️ <b>Network Interrupted</b>
                </div>`;
                bubbleDiv.innerHTML = marked.parse(accumulatedText) + errorHtml;
                throw streamError;
            }

            this.chatHistory.push({ role: 'bot', content: accumulatedText });

            const copyBtn = this.createCopyButton(accumulatedText);
            bubbleDiv.appendChild(copyBtn);

        } catch (error) {
            console.error('Streaming error flow:', error);

            // Clean up indicator if still present
            if (indicator && indicator.parentNode) {
                indicator.remove();
            }

            // QA Fix: Save partial history if substantial
            if (accumulatedText && accumulatedText.length > 5) {
                this.chatHistory.push({ role: 'bot', content: accumulatedText });

                // QA Fix: Add copy button even on error
                if (!bubbleDiv.querySelector('.copy-btn')) {
                    const copyBtn = this.createCopyButton(accumulatedText);
                    bubbleDiv.appendChild(copyBtn);
                }
            }

            // QA Fix: Robust check for empty state
            // If bubble is empty or only had indicator
            const hasContent = bubbleDiv.textContent.trim().length > 0 && !bubbleDiv.querySelector('.streaming-indicator');

            if (!hasContent && !bubbleDiv.innerHTML.includes('Error') && !bubbleDiv.innerHTML.includes('Connection failed')) {
                bubbleDiv.innerHTML = `<div style="color: #ff6b6b; font-weight: 500;">⚠️ Connection failed: ${this.escapeHtml(error.message)}</div>`;
            }

            // Re-throw to inform main sendMessage catch (optional)
            throw error;
        } finally {
            this.currentStreamingMessage = null;
        }
    }

    setStreamingState(streaming) {
        this.isStreaming = streaming;
        this.sendButton.disabled = streaming;
        this.messageInput.disabled = streaming;

        if (streaming) {
            this.messageInput.placeholder = 'Receiving response...';
            this.messageInput.style.opacity = '0.5';
        } else {
            this.messageInput.placeholder = 'Type your message...';
            this.messageInput.style.opacity = '1';
            this.messageInput.focus();
        }
    }

    scrollToBottom() {
        requestAnimationFrame(() => {
            this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        });
    }
}

// Initialize the chat interface when the page loads
document.addEventListener('DOMContentLoaded', () => {
    new ChatInterface();
});
