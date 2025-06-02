document.addEventListener('DOMContentLoaded', () => {
    const userInput = document.getElementById('userInput');
    const sendButton = document.getElementById('sendButton');
    const chatHistory = document.getElementById('chat-history');
    const toast = document.getElementById('toast');
    
    // Generate a unique session ID for this browser tab
    const sessionId = crypto.randomUUID();

    function showToast(message, isWarning = false) {
        toast.textContent = message;
        toast.style.display = 'block';
        if (isWarning) {
            toast.style.background = '#f39c12';
        } else {
            toast.style.background = '#e74c3c';
        }
        setTimeout(() => {
            toast.style.display = 'none';
        }, 5000);
    }

    function addMessage(content, isUser = false, isError = false) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${isUser ? 'user-message' : 'assistant-message'}`;
        
        if (isUser || isError) {
            messageDiv.textContent = content;
        } else {
            try {
                // Log the received response
                console.log('Received response:', content);
                messageDiv.innerHTML = marked.parse(content);
            } catch (e) {
                console.error('Error parsing markdown:', e);
                messageDiv.textContent = content;
            }
        }
        
        chatHistory.appendChild(messageDiv);
        chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    function showLoading() {
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
        const loadingMessage = document.getElementById('loading-message');
        if (loadingMessage) {
            loadingMessage.remove();
        }
    }

    async function sendQuery() {
        const query = userInput.value.trim();
        
        if (!query) {
            showToast('Please enter a message');
            return;
        }

        addMessage(query, true);
        userInput.value = '';
        
        sendButton.disabled = true;
        showLoading();

        try {
            console.log('Sending query:', { query, sessionId });
            const response = await fetch('/.netlify/functions/app', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ 
                    query,
                    sessionId 
                }),
            });

            const data = await response.json();
            console.log('Received response data:', data);

            removeLoading();

            if (response.ok && data.response) {
                addMessage(data.response);
                if (data.message_limit_reached) {
                    showToast('Message limit reached. Only keeping last 10 messages as context.', true);
                }
            } else {
                const errorMessage = data.error || 'An error occurred';
                console.error('Error response:', errorMessage);
                showToast(errorMessage);
            }
        } catch (error) {
            console.error('Request error:', error);
            removeLoading();
            const errorMessage = 'Failed to connect to server. Please try again.';
            showToast(errorMessage);
        } finally {
            sendButton.disabled = false;
        }
    }

    sendButton.addEventListener('click', sendQuery);

    userInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendQuery();
        }
    });
});