"""Synthetic backend fixture: a persisted product requirement list, not customer data."""
import json
import os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import psycopg

def title(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 200:
        raise ValueError('Title must contain 1 to 200 characters')
    return value.strip()

class Handler(BaseHTTPRequestHandler):
    def reply(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/':
            data = Path(__file__).with_name('index.html').read_bytes()
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        try:
            with psycopg.connect(os.environ['DATABASE_URL']) as db:
                if self.path == '/health':
                    db.execute('SELECT 1').fetchone()
                    return self.reply(200, {'status': 'healthy', 'fixture': True})
                if self.path == '/items':
                    rows = db.execute('SELECT id,title FROM requirement ORDER BY id').fetchall()
                    return self.reply(200, {'items': [{'id': r[0], 'title': r[1]} for r in rows]})
                self.reply(404, {'error': 'Not found'})
        except Exception:
            self.reply(503, {'error': 'Database unavailable'})

    def do_POST(self):
        if self.path != '/items':
            return self.reply(404, {'error': 'Not found'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 1024:
                raise ValueError()
            value = title(json.loads(self.rfile.read(length))['title'])
        except (ValueError, KeyError):
            return self.reply(400, {'error': 'Invalid item'})
        with psycopg.connect(os.environ['DATABASE_URL']) as db:
            row = db.execute('INSERT INTO requirement(title) VALUES(%s) RETURNING id', (value,)).fetchone()
        self.reply(201, {'id': row[0], 'title': value})

if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PORT', '8080'))), Handler).serve_forever()
