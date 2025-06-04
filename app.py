from flask import Flask, render_template, request, jsonify, session, make_response
from openai import OpenAI
import os
import uuid
import argparse
from datetime import datetime, timedelta
import secrets
import asyncio
from concurrent.futures import ThreadPoolExecutor
from queue import Queue
import threading
import time
from functools import wraps
import traceback
import logging

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(message)s',
    datefmt='%H:%M:%S'
)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.secret_key = os.urandom(24)
app.permanent_session_lifetime = timedelta(hours=24)
app.config['SESSION_COOKIE_SECURE'] = True
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Strict'

# Global request queue and worker thread
request_queue = Queue()
MAX_CONCURRENT_REQUESTS = 4
request_semaphore = threading.Semaphore(MAX_CONCURRENT_REQUESTS)
executor = ThreadPoolExecutor(max_workers=MAX_CONCURRENT_REQUESTS)

# Rate limiting
RATE_LIMIT_WINDOW = 60
RATE_LIMIT_MAX_REQUESTS = 30
rate_limit_store = {}

def generate_session_token():
    """Generate a secure random token for session identification"""
    return secrets.token_urlsafe(32)

def create_new_session():
    """Create a new session with all required fields"""
    logger.debug("Creating new session")
    session_id = str(uuid.uuid4())
    session_token = generate_session_token()
    
    session['session_id'] = session_id
    session['session_token'] = session_token
    session['messages'] = []
    session['last_activity'] = datetime.utcnow().isoformat()
    session.permanent = True
    session.modified = True
    
    logger.debug(f"New session created with ID: {session_id}")
    return session_id, session_token

def rate_limit(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        logger.debug("Rate limit check started")
        logger.debug(f"Session contents: {dict(session)}")
        
        session_id = session.get('session_id')
        if not session_id:
            logger.error("No session ID found in session")
            # Try to create a new session
            session_id, _ = create_new_session()
        
        current_time = time.time()
        if session_id not in rate_limit_store:
            logger.debug(f"New rate limit entry for session {session_id}")
            rate_limit_store[session_id] = {
                'count': 0,
                'window_start': current_time
            }

        # Reset counter if window has passed
        if current_time - rate_limit_store[session_id]['window_start'] > RATE_LIMIT_WINDOW:
            logger.debug(f"Rate limit window reset for session {session_id}")
            rate_limit_store[session_id] = {
                'count': 0,
                'window_start': current_time
            }

        # Check rate limit
        if rate_limit_store[session_id]['count'] >= RATE_LIMIT_MAX_REQUESTS:
            logger.warning(f"Rate limit exceeded for session {session_id}")
            return jsonify({
                'error': 'Rate limit exceeded. Please try again later.',
                'retry_after': int(RATE_LIMIT_WINDOW - (current_time - rate_limit_store[session_id]['window_start']))
            }), 429

        rate_limit_store[session_id]['count'] += 1
        logger.debug(f"Rate limit check passed for session {session_id}")
        return f(*args, **kwargs)
    return decorated_function

def process_api_request(client, messages):
    """Process API request with retry logic"""
    logger.debug("Starting API request processing")
    max_retries = 3
    retry_delay = 1  # seconds

    for attempt in range(max_retries):
        try:
            logger.debug(f"API request attempt {attempt + 1}/{max_retries}")
            with request_semaphore:
                logger.debug("Acquired semaphore, sending request to API")
                logger.info(f"API Request - Queue Length: {executor._work_queue}, Active Threads: {len(executor._threads)}")
                logger.info(f"Message to API: {messages[-1]['content'][:100]}...")  # Show first 100 chars of last message
                response = client.chat.completions.create(
                    model="deepseek-chat",
                    messages=messages
                )
                logger.debug("API request successful")
                logger.info("API Response received successfully")
                return response
        except Exception as e:
            logger.error(f"API request failed on attempt {attempt + 1}: {str(e)}")
            logger.error(f"Traceback: {traceback.format_exc()}")
            if attempt == max_retries - 1:
                logger.error(f"API Request failed after {max_retries} attempts: {str(e)}")
                raise e
            logger.debug(f"Waiting {retry_delay * (attempt + 1)} seconds before retry")
            time.sleep(retry_delay * (attempt + 1))
    return None

# Error handlers
@app.errorhandler(404)
def not_found_error(error):
    return jsonify({'error': 'Not found'}), 404

@app.errorhandler(500)
def internal_error(error):
    return jsonify({'error': 'Internal server error'}), 500

# Load API key from config file
def load_api_key():
    """Load API key from config file"""
    logger.debug("Loading API key from config file")
    try:
        with open('.config', 'r') as f:
            for line in f:
                if line.startswith('api_key='):
                    logger.debug("API key found in config file")
                    return line.strip().split('=')[1]
    except FileNotFoundError:
        logger.error("Config file not found")
        return None
    except Exception as e:
        logger.error(f"Error loading API key: {str(e)}")
        return None

def validate_session():
    """Validate the current session"""
    logger.debug("Validating session")
    if 'session_id' not in session:
        logger.error("No session_id in session")
        return False
    if 'last_activity' not in session:
        logger.error("No last_activity in session")
        return False
    if 'messages' not in session:
        logger.error("No messages in session")
        return False
    if 'session_token' not in session:
        logger.error("No session_token in session")
        return False
    logger.debug("Session validation successful")
    return True

def update_session_activity():
    """Update the last activity timestamp"""
    logger.debug("Updating session activity")
    session['last_activity'] = datetime.utcnow().isoformat()
    session.modified = True

def get_bearer_token():
    """Extract bearer token from Authorization header"""
    logger.debug("Extracting bearer token")
    auth_header = request.headers.get('Authorization')
    if auth_header and auth_header.startswith('Bearer '):
        logger.debug("Bearer token found in header")
        return auth_header.split(' ')[1]
    logger.error("No valid bearer token found")
    return None

@app.route('/')
def home():
    logger.debug("Home route accessed")
    logger.debug(f"Session contents before validation: {dict(session)}")
    
    if not validate_session():
        logger.debug("Session validation failed, creating new session")
        session_id, session_token = create_new_session()
    else:
        logger.debug("Session validation successful")
        session_id = session['session_id']
        session_token = session['session_token']
    
    response = make_response(render_template('index.html', bearer_token=session_token))
    
    # Set session cookie with secure options
    response.set_cookie(
        'session_id',
        session_id,
        httponly=True,
        secure=True,
        samesite='Strict',
        max_age=86400
    )
    
    # Set Authorization header
    response.headers['Authorization'] = f'Bearer {session_token}'
    
    logger.debug(f"Home route response sent with session_id: {session_id}")
    return response

@app.route('/query', methods=['POST'])
@rate_limit
def query():
    logger.debug("Query endpoint accessed")
    logger.debug(f"Session contents: {dict(session)}")
    logger.debug(f"Request headers: {dict(request.headers)}")
    
    if not request.is_json:
        logger.error("Request is not JSON")
        return jsonify({'error': 'Request must be JSON'}), 400

    if not validate_session():
        logger.error("Invalid session, creating new session")
        session_id, session_token = create_new_session()
        return jsonify({'error': 'Session expired, please refresh the page'}), 401
    
    bearer_token = get_bearer_token()
    if not bearer_token or bearer_token != session['session_token']:
        logger.error(f"Invalid bearer token. Expected: {session['session_token']}, Got: {bearer_token}")
        return jsonify({'error': 'Invalid authentication token'}), 401

    user_input = request.json.get('query', '').strip()
    logger.debug(f"User input received: {user_input[:50]}...")  # Log first 50 chars
    
    if not user_input:
        logger.error("Empty user input")
        return jsonify({'error': 'Query cannot be empty'}), 400
    
    api_key = load_api_key()
    if not api_key:
        logger.error("API key not found")
        return jsonify({'error': 'API key not found'}), 500
    
    try:
        logger.debug("Adding user message to session")
        user_message = {"role": "user", "content": user_input}
        session['messages'].append(user_message)
        update_session_activity()
        
        client = OpenAI(api_key=api_key)
        client.base_url = "https://api.deepseek.com"
        logger.debug("OpenAI client initialized")
        
        logger.debug("Submitting API request to thread pool")
        future = executor.submit(process_api_request, client, session['messages'])
        logger.debug("Waiting for API response")
        response = future.result(timeout=40)
        
        if not response:
            logger.error("No response from API")
            return jsonify({'error': 'API request failed'}), 500
        
        logger.debug("Processing API response")
        assistant_message = {
            "role": response.choices[0].message.role,
            "content": response.choices[0].message.content
        }
        
        session['messages'].append(assistant_message)
        update_session_activity()
        logger.debug("Assistant message added to session")
        
        message_limit_reached = False
        if len(session['messages']) > 10:
            session['messages'] = session['messages'][-10:]
            message_limit_reached = True
            logger.debug("Message history trimmed")
        
        response = jsonify({
            'response': assistant_message['content'],
            'message_limit_reached': message_limit_reached
        })
        
        response.set_cookie(
            'session_id',
            session['session_id'],
            httponly=True,
            secure=True,
            samesite='Strict',
            max_age=86400
        )
        
        logger.debug("Query response sent successfully")
        return response
    except Exception as e:
        logger.error(f"Error in query endpoint: {str(e)}")
        logger.error(f"Traceback: {traceback.format_exc()}")
        return jsonify({'error': str(e)}), 500

def cleanup_rate_limits():
    """Periodically clean up expired rate limit entries"""
    logger.debug("Starting rate limit cleanup")
    while True:
        try:
            current_time = time.time()
            expired_sessions = [
                session_id for session_id, data in rate_limit_store.items()
                if current_time - data['window_start'] > RATE_LIMIT_WINDOW
            ]
            for session_id in expired_sessions:
                del rate_limit_store[session_id]
            logger.debug(f"Cleaned up {len(expired_sessions)} expired rate limit entries")
            time.sleep(60)
        except Exception as e:
            logger.error(f"Error in cleanup_rate_limits: {str(e)}")
            time.sleep(60)

if __name__ == '__main__':
    logger.info("Starting application")
    cleanup_thread = threading.Thread(target=cleanup_rate_limits, daemon=True)
    cleanup_thread.start()
    logger.debug("Rate limit cleanup thread started")

    parser = argparse.ArgumentParser(description='Run the Flask application')
    parser.add_argument('--port', type=int, default=5000, help='Port number to run the server on (default: 5000)')
    args = parser.parse_args()
    
    logger.info(f"Starting Flask server on port {args.port}")
    app.run(debug=True, port=args.port)