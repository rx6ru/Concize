class ChatInterface {
    constructor() {
        this.messagesContainer = document.getElementById('chatMessages');
        this.messageInput = document.getElementById('messageInput');
        this.sendButton = document.getElementById('sendButton');
        this.errorMessage = document.getElementById('errorMessage');
        this.opacitySlider = document.getElementById('opacitySlider');
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

        // Opacity slider
        this.opacitySlider.addEventListener('input', (e) => {
            this.updateOpacity(e.target.value);
        });

        // Initialize opacity
        this.updateOpacity(this.opacitySlider.value);
    }

    addWelcomeMessage() {
        const welcomeDiv = document.createElement('div');
        welcomeDiv.className = 'empty-state';
        welcomeDiv.innerHTML = `
            <div class="welcome-message">
                <h3>Welcome to Concize AI Assistant</h3>
                <p>Ask me anything about your audio recordings or any other topic!</p>
            </div>
        `;
        this.messagesContainer.appendChild(welcomeDiv);
    }

    updateOpacity(value) {
        const opacity = value / 100;
        
        // Apply opacity to the entire chat container (the whole floating window)
        this.chatContainer.style.opacity = opacity;
        
        // At very low opacity, ensure some visibility for interaction
        if (opacity < 0.1) {
            // Add a subtle outline when nearly invisible so users can still find it
            this.chatContainer.style.boxShadow = `0 0 0 1px rgba(255, 255, 255, ${0.3}), 0 8px 32px rgba(0, 0, 0, 0.3)`;
        } else if (opacity < 0.3) {
            // Reduced shadow for low opacity
            this.chatContainer.style.boxShadow = `0 8px 32px rgba(0, 0, 0, ${0.2})`;
        } else {
            // Normal shadow for higher opacity
            this.chatContainer.style.boxShadow = '0 8px 32px rgba(0, 0, 0, 0.3)';
        }
        
        // Store current opacity for potential future use
        this.currentOpacity = opacity;
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
            bubbleDiv.innerHTML = marked.parse(content);
        } else {
            bubbleDiv.textContent = content;
        }
        
        messageDiv.appendChild(bubbleDiv);
        this.messagesContainer.appendChild(messageDiv);
        this.scrollToBottom();
        
        return bubbleDiv;
    }

    async streamBotResponse(userMessage) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message bot';
        const bubbleDiv = document.createElement('div');
        bubbleDiv.className = 'message-bubble';
        const indicator = document.createElement('span');
        indicator.className = 'streaming-indicator';

        bubbleDiv.appendChild(indicator);
        messageDiv.appendChild(bubbleDiv);
        this.messagesContainer.appendChild(messageDiv);
        this.currentStreamingMessage = bubbleDiv;
        this.scrollToBottom();

        const API_URL = 'http://localhost:3000/api/chat/stream';
        
        try {
            const jobId = "73832ac1-8f22-4915-b7b3-a330c8911ddc";
            
            const response = await fetch(API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
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
