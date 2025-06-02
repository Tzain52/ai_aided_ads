from flask import Flask, render_template, request, jsonify, session
from flask_cors import CORS
from openai import OpenAI
import os
from dotenv import load_dotenv
import uuid
import json
from flask_socketio import SocketIO, emit

# Load environment variables
load_dotenv()

app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

# Use environment variable for secret key
app.secret_key = os.getenv('FLASK_SECRET_KEY', os.urandom(24))

# Store active sessions
active_sessions = {}

# Error handlers
@app.errorhandler(404)
def not_found_error(error):
    return jsonify({'error': 'Not found'}), 404

@app.errorhandler(500)
def internal_error(error):
    return jsonify({'error': 'Internal server error'}), 500

@app.route('/')
def home():
    return render_template('index.html')

@app.route('/admin')
def admin():
    return render_template('admin.html')

@app.route('/query', methods=['POST'])
def query():
    if not request.is_json:
        return jsonify({'error': 'Request must be JSON'}), 400

    data = request.get_json()
    user_input = data.get('query', '').strip()
    session_id = data.get('sessionId')
    
    if not user_input or not session_id:
        return jsonify({'error': 'Query and sessionId are required'}), 400
    
    api_key = os.getenv('OPENAI_API_KEY')
    if not api_key:
        return jsonify({'error': 'API key not configured'}), 500
    
    try:
        # Initialize or get session messages
        if session_id not in active_sessions:
            active_sessions[session_id] = []
        
        # Add user message to history
        user_message = {"role": "user", "content": user_input}
        active_sessions[session_id].append(user_message)
        
        client = OpenAI(api_key=api_key)
        client.base_url = "https://api.deepseek.com"
        
        # Send conversation history for this session
        response = client.chat.completions.create(
            model="deepseek-chat",
            messages=active_sessions[session_id]
        )
        
        # Extract the message content and role from the response
        assistant_message = {
            "role": response.choices[0].message.role,
            "content": response.choices[0].message.content
        }
        
        # Add assistant's response to history
        active_sessions[session_id].append(assistant_message)
        
        # Check if we need to trim messages
        message_limit_reached = False
        if len(active_sessions[session_id]) > 10:
            active_sessions[session_id] = active_sessions[session_id][-10:]
            message_limit_reached = True
        
        # Emit updated sessions to admin panel
        socketio.emit('sessions', list(active_sessions.items()))
        
        return jsonify({
            'response': assistant_message['content'],
            'message_limit_reached': message_limit_reached
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@socketio.on('connect')
def handle_connect():
    emit('sessions', list(active_sessions.items()))

@socketio.on('getSessions')
def handle_get_sessions():
    emit('sessions', list(active_sessions.items()))

@socketio.on('clearSession')
def handle_clear_session(session_id):
    if session_id in active_sessions:
        del active_sessions[session_id]
        emit('sessionCleared')
        emit('sessions', list(active_sessions.items()))

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=int(os.getenv('PORT', 5000)), debug=True)