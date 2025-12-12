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
            console.error('Error:', error);
            this.addMessage('Sorry, I encountered an error. Please try again.', 'bot');
            this.showError('Connection error. Please check if the server is running.');
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
        const indicator = document.createElement('div');
        indicator.className = 'streaming-indicator';
        indicator.innerHTML = 'Processing<span class="dot">.</span><span class="dot">.</span><span class="dot">.</span>';

        bubbleDiv.appendChild(indicator);
        messageDiv.appendChild(bubbleDiv);
        this.messagesContainer.appendChild(messageDiv);
        this.currentStreamingMessage = bubbleDiv;
        this.scrollToBottom();

        const API_URL = 'http://localhost:3000/api/chat/stream';
        
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

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let accumulatedText = '';
            let indicatorRemoved = false;

            while (true) {
                const { done, value } = await reader.read();
                
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const lines = chunk.split('\n');
                
                for (const line of lines) {
                    const trimmedLine = line.trim();
                    if (trimmedLine) {
                        try {
                            let jsonData;
                            if (trimmedLine.startsWith('data: ')) {
                                const jsonStr = trimmedLine.slice(6);
                                if (jsonStr === '[DONE]') break;
                                jsonData = JSON.parse(jsonStr);
                            } else {
                                jsonData = JSON.parse(trimmedLine);
                            }
                            
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
                                await new Promise(resolve => setTimeout(resolve, 20));
                            }
                        } catch (e) {
                            if (trimmedLine !== 'data:' && !trimmedLine.startsWith('event:')) {
                                console.warn('Failed to parse JSON line:', trimmedLine, e);
                            }
                        }
                    }
                }
            }

            this.chatHistory.push({ role: 'bot', content: accumulatedText });

            const copyBtn = this.createCopyButton(accumulatedText);
            bubbleDiv.appendChild(copyBtn);

        } catch (error) {
            console.error('Streaming error:', error);
            if (indicator && indicator.parentNode) {
                indicator.remove();
            }
            if (this.currentStreamingMessage) {
                this.currentStreamingMessage.textContent = "Sorry, I'm having trouble connecting to the server. Please try again.";
            }
            this.showError(`Connection failed: ${error.message}`);
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
