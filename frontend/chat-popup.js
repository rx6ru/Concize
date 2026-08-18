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

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

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

    async streamBotResponse(userMessage) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message bot';
        const bubbleDiv = document.createElement('div');
        bubbleDiv.className = 'message-bubble';

        const errorIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;

        const indicator = document.createElement('div');
        indicator.className = 'streaming-indicator';
        indicator.innerHTML = 'Processing<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>';

        bubbleDiv.appendChild(indicator);
        messageDiv.appendChild(bubbleDiv);
        this.messagesContainer.appendChild(messageDiv);
        this.currentStreamingMessage = bubbleDiv;
        this.scrollToBottom();

        let accumulatedText = '';
        try {
            const { meetingId } = await chrome.storage.local.get('meetingId');
            if (!meetingId) {
                indicator.remove();
                bubbleDiv.classList.add('error-bubble');
                bubbleDiv.innerHTML = `<div class="message-content"><p>No active meeting — start a recording first.</p></div>`;
                this.currentStreamingMessage = null;
                return;
            }

            let response;
            try {
                response = await ConcizeAuth.authedFetch(`/api/v1/meetings/${meetingId}/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userPrompt: userMessage })
                });
            } catch (authError) {
                indicator.remove();
                bubbleDiv.classList.add('error-bubble');
                const msg = authError.message === 'Not signed in'
                    ? 'You are not signed in. Please sign in via the extension popup and try again.'
                    : authError.message;
                bubbleDiv.innerHTML = `<div class="message-content"><p>${this.escapeHtml(msg)}</p></div>`;
                this.currentStreamingMessage = null;
                return;
            }

            // Pre-stream HTTP errors (429, 503, 500).
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

                indicator.remove();

                bubbleDiv.classList.add('error-bubble');
                bubbleDiv.innerHTML = `${errorIconSvg}<div class="message-content"><p>${this.escapeHtml(errorMessage)}</p></div>`;

                // Throwing here stops further execution and is caught by the outer catch block
                throw new Error(errorMessage);
            }

            // Streaming phase.
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            
            let indicatorRemoved = false;
            let isErrorEvent = false; // Flag for multi-line SSE events
            let buffer = '';

            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop(); // Keep incomplete line in buffer

                    for (const line of lines) {
                        const trimmedLine = line.trim();
                        if (!trimmedLine) continue;

                        // Mid-stream SSE errors.
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

                                    const errorHtml = `<div class="mid-stream-error">
                                        ${errorIconSvg}
                                        <div class="message-content"><b>Connection Lost:</b> ${this.escapeHtml(errMsg)}</div>
                                    </div>`;

                                    bubbleDiv.innerHTML = marked.parse(accumulatedText) + errorHtml;
                                    isErrorEvent = false;
                                    return;
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
                const errorHtml = `<div class="mid-stream-error">
                    ${errorIconSvg}
                    <div class="message-content"><b>Network Interrupted</b></div>
                </div>`;
                bubbleDiv.innerHTML = marked.parse(accumulatedText) + errorHtml;
                throw streamError;
            }

            // Only add to history and add copy button on full success
            if (accumulatedText) {
                this.chatHistory.push({ role: 'bot', content: accumulatedText });
                const copyBtn = this.createCopyButton(accumulatedText);
                bubbleDiv.appendChild(copyBtn);
            }

        } catch (error) {
            // console.error('Streaming error flow:', error);

            // Clean up indicator if still present
            if (indicator && indicator.parentNode) {
                indicator.remove();
            }
            
            const hasContent = bubbleDiv.textContent.trim().length > 0 && !bubbleDiv.querySelector('.streaming-indicator');

            // Fallback to display a generic error if the bubble is still empty
            if (!hasContent && !bubbleDiv.innerHTML.includes('error-bubble') && !bubbleDiv.innerHTML.includes('mid-stream-error')) {
                 bubbleDiv.classList.add('error-bubble');
                //  bubbleDiv.innerHTML = `${errorIconSvg}<div class="message-content"><p>${this.escapeHtml(error.message)}</p></div>`;
                 bubbleDiv.innerHTML = `${errorIconSvg}<div class="message-content"><p>Sorry, I'm having trouble connecting to the server. Please try again.</p></div>`;
            }

            // DO NOT re-throw here, as this function handles all UI updates for errors.
            // throw error; 
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
