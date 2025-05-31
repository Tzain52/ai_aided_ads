from flask import Flask, render_template, request, jsonify
from openai import OpenAI
import os

app = Flask(__name__)

# Load API key from config file
def load_api_key():
    print("\n[DEBUG] Attempting to load API key from .config file")
    try:
        with open('.config', 'r') as f:
            print("[DEBUG] Successfully opened .config file")
            for line in f:
                if line.startswith('api_key='):
                    key = line.strip().split('=')[1]
                    print(f"[DEBUG] Found API key: {key[:5]}...{key[-5:] if len(key) > 10 else ''}")
                    return key
            print("[DEBUG] No api_key found in .config file")
    except FileNotFoundError:
        print("[DEBUG] .config file not found")
        return None
    except Exception as e:
        print(f"[DEBUG] Error reading .config file: {str(e)}")
        return None

@app.route('/')
def home():
    print("\n[DEBUG] Home route accessed")
    return render_template('index.html')

@app.route('/query', methods=['POST'])
def query():
    print("\n[DEBUG] Query endpoint accessed")
    print(f"[DEBUG] Request JSON: {request.json}")
    
    user_input = request.json.get('query', '').strip()
    print(f"[DEBUG] User input: {user_input}")
    
    if not user_input:
        print("[DEBUG] Empty query received")
        return jsonify({'error': 'Query cannot be empty'}), 400
    
    api_key = load_api_key()
    print(f"[DEBUG] API key loaded: {'Yes' if api_key else 'No'}")
    
    if not api_key:
        print("[DEBUG] No API key found, returning error")
        return jsonify({'error': 'API key not found'}), 500
    
    try:
        print("[DEBUG] Initializing OpenAI client")
        print(api_key)
        client = OpenAI(api_key=api_key, base_url="https://api.deepseek.com")
        print("[DEBUG] Setting base URL")
        # client.base_url = "https://api.deepseek.com"
        
        print("[DEBUG] Creating chat completion request")
        print(f"[DEBUG] Model: deepseek-chat")
        print(f"[DEBUG] Messages: {[{'role': 'system', 'content': 'You are a helpful assistant'}, {'role': 'user', 'content': user_input}]}")
        
        response = client.chat.completions.create(
            model="deepseek-chat",
            messages=[
                {"role": "system", "content": "You are a helpful assistant"},
                {"role": "user", "content": user_input},
            ],
            stream=False
        )
        print("[DEBUG] Response received successfully")
        print(f"[DEBUG] Response content: {response.choices[0].message.content[:1000]}...")
        
        return jsonify({'response': response.choices[0].message.content})
    except Exception as e:
        print(f"[DEBUG] Error occurred: {str(e)}")
        print(f"[DEBUG] Error type: {type(e)}")
        import traceback
        print(f"[DEBUG] Full traceback:\n{traceback.format_exc()}")
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    print("\n[DEBUG] Starting Flask application")
    print("[DEBUG] Debug mode is ON")
    app.run(debug=True) 