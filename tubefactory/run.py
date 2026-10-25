"""Start TubeFactory: python run.py  ->  http://127.0.0.1:8000"""
import argparse
import webbrowser

import uvicorn

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    if not args.no_browser:
        webbrowser.open(f"http://{args.host}:{args.port}")
    uvicorn.run("app.server:app", host=args.host, port=args.port)
