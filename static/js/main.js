document.addEventListener('DOMContentLoaded', () => {
    const userInput = document.getElementById('userInput');
    const sendButton = document.getElementById('sendButton');
    const responseArea = document.getElementById('response');
    const toast = document.getElementById('toast');

    function showToast(message) {
        toast.textContent = message;
        toast.style.display = 'block';
        setTimeout(() => {
            toast.style.display = 'none';
        }, 3000);
    }

    function showLoading() {
        responseArea.innerHTML = '<span class="loading">Thinking</span>';
    }

    function renderAdBox() {
        // You can randomize or rotate ad texts if you want
        const adText = "Would Stride & Co. shoes be a good fit for people with wide feet?";
        return `
            <div class="ad-box">
                <span>${adText}</span>
                <span class="ad-tag">ads</span>
            </div>
        `;
    }

    async function sendQuery() {
        const query = userInput.value.trim();
        
        if (!query) {
            showToast('Query cannot be empty');
            return;
        }

        sendButton.disabled = true;
        showLoading();

        try {
            const response = await fetch('/query', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ query }),
            });

            const data = await response.json();

            if (response.ok) {
                // Parse markdown and set HTML content, then append ad box
                responseArea.innerHTML = marked.parse(data.response) + renderAdBox();
            } else {
                responseArea.textContent = `Error: ${data.error}`;
            }
        } catch (error) {
            responseArea.textContent = `Error: ${error.message}`;
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