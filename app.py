from flask import Flask, render_template, request, jsonify, session
from flask_cors import CORS
from openai import OpenAI
import os
from dotenv import load_dotenv
import uuid
import json
from flask_socketio import SocketIO, emit
import logging
import traceback

# Configure logging
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Load environment variables
load_dotenv()
logger.debug("Environment variables loaded")

app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")
logger.info("Flask app initialized with CORS and SocketIO")

# Use environment variable for secret key
app.secret_key = os.getenv('FLASK_SECRET_KEY', os.urandom(24))
logger.debug(f"Secret key configured: {'from env' if os.getenv('FLASK_SECRET_KEY') else 'random generated'}")

# Store active sessions
active_sessions = {}

def format_error_response(error_message, error_details=None):
    response = {
        'error': error_message,
        'status': 'error'
    }
    if error_details and app.debug:
        response['details'] = error_details
    return response

# Error handlers
@app.errorhandler(404)
def not_found_error(error):
    error_details = str(error)
    logger.error(f"404 error: {error_details}")
    return jsonify(format_error_response('Resource not found', error_details)), 404

@app.errorhandler(500)
def internal_error(error):
    error_details = str(error)
    logger.error(f"500 error: {error_details}")
    return jsonify(format_error_response('Internal server error', error_details)), 500

@app.route('/')
def home():
    logger.debug("Serving home page")
    return render_template('index.html')

@app.route('/admin')
def admin():
    logger.debug("Serving admin page")
    return render_template('admin.html')

@app.route('/query', methods=['POST'])
def query():
    logger.debug("Received query request")
    
    try:
        if not request.is_json:
            error_msg = "Request is not JSON"
            logger.error(error_msg)
            return jsonify(format_error_response(error_msg)), 400

        data = request.get_json()
        user_input = data.get('query', '').strip()
        session_id = data.get('sessionId')
        
        logger.debug(f"Processing query for session {session_id}")
        logger.debug(f"User input: {user_input[:50]}...")  # Log first 50 chars of input
        
        if not user_input:
            error_msg = "Query cannot be empty"
            logger.error(error_msg)
            return jsonify(format_error_response(error_msg)), 400
            
        if not session_id:
            error_msg = "SessionId is required"
            logger.error(error_msg)
            return jsonify(format_error_response(error_msg)), 400
        
        api_key = os.getenv('OPENAI_API_KEY')
        if not api_key:
            error_msg = "API key not configured"
            logger.error(error_msg)
            return jsonify(format_error_response(error_msg)), 500
        
        logger.debug(f"Initializing session {session_id}")
        if session_id not in active_sessions:
            active_sessions[session_id] = []
        
        user_message = {"role": "user", "content": user_input}
        active_sessions[session_id].append(user_message)
        
        logger.debug("Initializing OpenAI client")
        client = OpenAI(api_key=api_key)
        client.base_url = "https://api.deepseek.com"
        
        logger.debug("Sending request to OpenAI")
        response = client.chat.completions.create(
            model="deepseek-chat",
            messages=active_sessions[session_id]
        )
        
        assistant_message = {
            "role": response.choices[0].message.role,
            "content": response.choices[0].message.content
        }
        logger.debug("Received response from OpenAI")
        logger.debug(f"Assistant response length: {len(assistant_message['content'])}")
        
        active_sessions[session_id].append(assistant_message)
        
        message_limit_reached = False
        if len(active_sessions[session_id]) > 10:
            logger.debug(f"Trimming message history for session {session_id}")
            active_sessions[session_id] = active_sessions[session_id][-10:]
            message_limit_reached = True
        
        logger.debug("Emitting updated sessions to admin panel")
        socketio.emit('sessions', list(active_sessions.items()))
        
        return jsonify({
            'response': assistant_message['content'],
            'message_limit_reached': message_limit_reached,
            'status': 'success'
        })
    except Exception as e:
        error_details = {
            'message': str(e),
            'traceback': traceback.format_exc()
        }
        logger.error(f"Error processing request: {str(e)}", exc_info=True)
        return jsonify(format_error_response('An error occurred while processing your request', error_details)), 500

@socketio.on('connect')
def handle_connect():
    logger.debug("New socket connection established")
    emit('sessions', list(active_sessions.items()))

@socketio.on('getSessions')
def handle_get_sessions():
    logger.debug("Received getSessions request")
    emit('sessions', list(active_sessions.items()))

@socketio.on('clearSession')
def handle_clear_session(session_id):
    logger.debug(f"Clearing session {session_id}")
    if session_id in active_sessions:
        del active_sessions[session_id]
        emit('sessionCleared')
        emit('sessions', list(active_sessions.items()))

if __name__ == '__main__':
    logger.info("Starting application")
    socketio.run(app, host='0.0.0.0', port=int(os.getenv('PORT', 5000)), debug=True)