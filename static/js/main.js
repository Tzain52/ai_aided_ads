document.addEventListener('DOMContentLoaded', () => {
    const userInput = document.getElementById('userInput');
    const sendButton = document.getElementById('sendButton');
    const chatHistory = document.getElementById('chat-history');
    const toast = document.getElementById('toast');

    function showToast(message, isWarning = false) {
        toast.textContent = message;
        toast.style.display = 'block';
        if (isWarning) {
            toast.style.background = '#f39c12'; // Orange color for warnings
        } else {
            toast.style.background = '#e74c3c'; // Red color for errors
        }
        setTimeout(() => {
            toast.style.display = 'none';
        }, 3000);
    }

    function addMessage(content, isUser = false) {
        const messageDiv = document.createElement('div');
        messageDiv.className = `message ${isUser ? 'user-message' : 'assistant-message'}`;
        
        if (isUser) {
            messageDiv.textContent = content;
        } else {
            messageDiv.innerHTML = marked.parse(content);
        }
        
        chatHistory.appendChild(messageDiv);
        // Scroll to bottom
        chatHistory.scrollTop = chatHistory.scrollHeight;
    }

    function showLoading() {
        const loadingDiv = document.createElement('div');
        loadingDiv.className = 'message assistant-message';
        loadingDiv.innerHTML = '<span class="loading">Thinking</span>';
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
            showToast('Query cannot be empty');
            return;
        }

        // Add user message to chat
        addMessage(query, true);
        
        // Clear input
        userInput.value = '';
        
        sendButton.disabled = true;
        showLoading();

        try {
            const response = await fetch('/.netlify/functions/app', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({ query }),
            });

            const contentType = response.headers.get('content-type');
            if (!contentType || !contentType.includes('application/json')) {
                throw new Error('Server returned non-JSON response');
            }

            const data = await response.json();

            if (response.ok) {
                removeLoading();
                addMessage(data.response);
                
                // Show warning toast if message limit is reached
                if (data.message_limit_reached) {
                    showToast('Message limit reached. Only keeping last 10 messages as context.', true);
                }
            } else {
                removeLoading();
                const errorMessage = data.error || 'An error occurred';
                addMessage(`Error: ${errorMessage}`);
                showToast(errorMessage);
            }
        } catch (error) {
            removeLoading();
            const errorMessage = error.message || 'Failed to connect to server';
            addMessage(`Error: ${errorMessage}`);
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