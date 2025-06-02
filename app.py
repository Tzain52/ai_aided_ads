from flask import Flask, render_template, request, jsonify, session
from openai import OpenAI
import os
import uuid

app = Flask(__name__)
app.secret_key = os.urandom(24)  # Required for session management

# Error handlers
@app.errorhandler(404)
def not_found_error(error):
    return jsonify({'error': 'Not found'}), 404

@app.errorhandler(500)
def internal_error(error):
    return jsonify({'error': 'Internal server error'}), 500

# Load API key from config file
def load_api_key():
    try:
        with open('.config', 'r') as f:
            for line in f:
                if line.startswith('api_key='):
                    return line.strip().split('=')[1]
    except FileNotFoundError:
        return None

@app.route('/')
def home():
    # Initialize a new session ID if not exists
    if 'session_id' not in session:
        session['session_id'] = str(uuid.uuid4())
        session['messages'] = []
    return render_template('index.html')

@app.route('/query', methods=['POST'])
def query():
    if not request.is_json:
        return jsonify({'error': 'Request must be JSON'}), 400

    user_input = request.json.get('query', '').strip()
    
    if not user_input:
        return jsonify({'error': 'Query cannot be empty'}), 400
    
    api_key = load_api_key()
    if not api_key:
        return jsonify({'error': 'API key not found'}), 500
    
    try:
        # Initialize messages list if not exists
        if 'messages' not in session:
            session['messages'] = []
        
        # Add user message to history
        user_message = {"role": "user", "content": user_input}
        session['messages'].append(user_message)
        session.modified = True  # Mark session as modified
        
        print('After adding user message:', session['messages'])
        
        client = OpenAI(api_key=api_key)
        client.base_url = "https://api.deepseek.com"
        
        # Send entire conversation history
        response = client.chat.completions.create(
            model="deepseek-chat",
            messages=session['messages']
        )
        
        # Extract the message content and role from the response
        assistant_message = {
            "role": response.choices[0].message.role,
            "content": response.choices[0].message.content
        }
        
        # Add assistant's response to history
        session['messages'].append(assistant_message)
        session.modified = True  # Mark session as modified
        
        print('After adding assistant message:', session['messages'])
        
        # Check if we need to trim messages
        message_limit_reached = False
        if len(session['messages']) > 10:
            session['messages'] = session['messages'][-10:]
            session.modified = True  # Mark session as modified
            message_limit_reached = True
        
        return jsonify({
            'response': assistant_message['content'],
            'message_limit_reached': message_limit_reached
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(debug=True)