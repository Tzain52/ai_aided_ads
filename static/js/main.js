document.addEventListener('DOMContentLoaded', () => {
    console.log('[Frontend] Initializing application');
    const userInput = document.getElementById('userInput');
    const sendButton = document.getElementById('sendButton');
    const chatHistory = document.getElementById('chat-history');
    const toast = document.getElementById('toast');

    function showToast(message, isWarning = false) {
        console.log(`[Frontend] Showing toast: ${message}`, { isWarning });
        toast.textContent = message;
        toast.style.display = 'block';
        toast.style.background = isWarning ? '#f39c12' : '#e74c3c';
        setTimeout(() => {
            console.log('[Frontend] Hiding toast');
            toast.style.display = 'none';
        }, 5000);
    }

    function addMessage(content, isUser = false, isError = false) {
        console.log('[Frontend] Adding message', { isUser, isError, contentLength: content.length });
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${isUser ? 'user-message' : 'assistant-message'}`;
        
        if (isUser || isError) {
            messageDiv.textContent = content;
        } else {
            try {
                console.log('[Frontend] Parsing markdown response');
                messageDiv.innerHTML = marked.parse(content);
                console.log('[Frontend] Markdown parsed successfully');
            } catch (e) {
                console.error('[Frontend] Error parsing markdown:', e);
                messageDiv.textContent = content;
            }
        }
        
        chatHistory.appendChild(messageDiv);
        chatHistory.scrollTop = chatHistory.scrollHeight;
        console.log('[Frontend] Message added and scrolled to view');
    }

    function showLoading() {
        console.log('[Frontend] Showing loading animation');
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'message assistant-message';
        loadingDiv.innerHTML = `
            <div class="drum-animation">
                <span class="drum">🥁</span>
                <span class="drum">🥁</span>
                <span class="drum">🥁</span>
            </div>
        `;
        loadingDiv.id = 'loading-message';
        chatHistory.appendChild(loadingDiv);
        chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    function removeLoading() {
        console.log('[Frontend] Removing loading animation');
        const loadingMessage = document.getElementById('loading-message');
        if (loadingMessage) {
            loadingMessage.remove();
        }
    }

    async function sendQuery() {
        const query = userInput.value.trim();
        console.log('[Frontend] Preparing to send query', { queryLength: query.length });
        
        if (!query) {
            console.log('[Frontend] Empty query detected');
            showToast('Please enter a message');
            return;
        }

        console.log('[Frontend] Adding user message to chat');
        addMessage(query, true);
        userInput.value = '';
        
        sendButton.disabled = true;
        showLoading();

        try {
            console.log('[Frontend] Sending request to backend');
            const response = await fetch('/.netlify/functions/app', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ query }),
            });

            console.log('[Frontend] Received response from backend', { status: response.status });
            const data = await response.json();
            console.log('[Frontend] Parsed response data', { 
                hasResponse: !!data.response,
                responseLength: data.response ? data.response.length : 0
            });

            removeLoading();

            if (response.ok && data.response) {
                console.log('[Frontend] Adding assistant response to chat');
                addMessage(data.response);
            } else {
                const errorMessage = data.error || 'An error occurred';
                console.error('[Frontend] Error response:', errorMessage);
                showToast(errorMessage);
            }
        } catch (error) {
            console.error('[Frontend] Request error:', error);
            removeLoading();
            showToast('Failed to connect to server. Please try again.');
        } finally {
            console.log('[Frontend] Request completed');
            sendButton.disabled = false;
        }
    }

    console.log('[Frontend] Setting up event listeners');
    sendButton.addEventListener('click', sendQuery);

    userInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            console.log('[Frontend] Enter key pressed (without shift)');
            e.preventDefault();
            sendQuery();
        }
    });

    console.log('[Frontend] Application initialization complete');
});