from http.server import BaseHTTPRequestHandler
from openai import OpenAI
import os
import json
from urllib.parse import parse_qs

class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        # Validate origin
        origin = self.headers.get('Origin', '')
        allowed_origins = os.getenv('ALLOWED_ORIGINS', '').split(',')
        
        if origin not in allowed_origins:
            self.send_error(403, 'Origin not allowed')
            return
            
        content_length = int(self.headers['Content-Length'])
        post_data = self.rfile.read(content_length)
        data = json.loads(post_data)
        
        user_input = data.get('query', '').strip()
        
        if not user_input:
            self.send_error(400, 'Query cannot be empty')
            return
        
        api_key = os.getenv('OPENAI_API_KEY')
        if not api_key:
            self.send_error(500, 'API key not configured')
            return
        
        try:
            client = OpenAI(api_key=api_key)
            client.base_url = "https://api.deepseek.com"
            
            response = client.chat.completions.create(
                model="deepseek-chat",
                messages=[{"role": "user", "content": user_input}]
            )
            
            assistant_message = {
                "role": response.choices[0].message.role,
                "content": response.choices[0].message.content
            }
            
            self.send_response(200)
            self.send_header('Content-type', 'application/json')
            self.send_header('Access-Control-Allow-Origin', origin)
            self.send_header('Access-Control-Allow-Credentials', 'true')
            self.end_headers()
            
            response_data = {
                'response': assistant_message['content'],
                'message_limit_reached': False
            }
            
            self.wfile.write(json.dumps(response_data).encode())
            
        except Exception as e:
            self.send_error(500, str(e))
            
    def do_OPTIONS(self):
        origin = self.headers.get('Origin', '')
        allowed_origins = os.getenv('ALLOWED_ORIGINS', '').split(',')
        
        if origin not in allowed_origins:
            self.send_error(403, 'Origin not allowed')
            return
            
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', origin)
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Credentials', 'true')
        self.end_headers()