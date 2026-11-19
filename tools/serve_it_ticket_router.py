#!/usr/bin/env python3
"""Loopback-only preview API backed by the native IT routing classifier."""
import argparse,hashlib,json,selectors,subprocess,threading
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--head',type=Path,required=True)
    parser.add_argument('--pack',type=Path,default=ROOT/'models/ticketing-ja/optimized-seed29-v1/int8')
    parser.add_argument('--port',type=int,default=5191)
    args=parser.parse_args()
    raw=args.head.read_bytes();head=json.loads(raw)
    digest=hashlib.sha256((args.pack/'manifest.json').read_bytes()).digest()
    if bytes(head['base_model'])!=digest:raise ValueError('Head is bound to a different encoder pack')
    proc=subprocess.Popen([str(ROOT/'target/release/it-routing-infer'),str(args.pack),str(args.head)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,bufsize=1)
    lock=threading.Lock()
    info=dict(model=list(hashlib.sha256(raw).digest()),base_model=list(digest),ready=True,validated=head.get('validated',False),max_tokens=64,runtime='local')
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args):pass  # Do not log ticket contents or URLs.
        def send(self,status,value):
            data=json.dumps(value,ensure_ascii=False).encode();self.send_response(status)
            self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        def do_GET(self):
            if self.path!='/api/it-routing/info':return self.send(404,dict(error='Not found'))
            return self.send(200,{**info,'ready':proc.poll() is None})
        def do_POST(self):
            if self.path!='/api/it-routing/classify':return self.send(404,dict(error='Not found'))
            origin=self.headers.get('Origin')
            if origin:
                from urllib.parse import urlparse
                if urlparse(origin).hostname not in ('127.0.0.1','localhost'):return self.send(403,dict(error='Origin not allowed'))
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 0<length<=16384:raise ValueError('Invalid body length')
                value=json.loads(self.rfile.read(length));text=value['text']
                if not isinstance(text,str) or not text.strip() or len(text.encode())>8192:raise ValueError('Invalid ticket text')
                with lock:
                    if proc.poll() is not None:raise RuntimeError('Inference unavailable')
                    proc.stdin.write(json.dumps(dict(text=text),ensure_ascii=False)+'\n');proc.stdin.flush()
                    with selectors.DefaultSelector() as selector:
                        selector.register(proc.stdout,selectors.EVENT_READ)
                        if not selector.select(30):proc.kill();raise RuntimeError('Inference timed out')
                    line=proc.stdout.readline()
                    if not line:raise RuntimeError('Inference unavailable')
                    result=json.loads(line)
                if 'error' in result:return self.send(400,dict(error=result['error']))
                return self.send(200,dict(model=info['model'],base_model=info['base_model'],input_tokens=len(result['ids']),result=result['result'],elapsed_ms=result['elapsed_ms']))
            except (ValueError,KeyError,TypeError):return self.send(400,dict(error='Invalid request'))
            except (RuntimeError,BrokenPipeError):return self.send(503,dict(error='Inference unavailable'))
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    print(f'Local IT routing API: http://127.0.0.1:{args.port}; validated={info["validated"]}',flush=True)
    try:server.serve_forever()
    finally:
        server.server_close();proc.terminate();proc.wait(timeout=10)
if __name__=='__main__':main()
