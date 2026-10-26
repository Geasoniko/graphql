"""Start TubeFactory: python run.py  ->  http://127.0.0.1:8000"""
import argparse
import socket
import sys
import webbrowser

import requests
import uvicorn


def port_busy(host, port):
    with socket.socket() as s:
        return s.connect_ex((host, port)) == 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    url = f"http://{args.host}:{args.port}"
    if port_busy(args.host, args.port):
        try:
            ours = requests.get(f"{url}/api/settings", timeout=3).ok
        except requests.RequestException:
            ours = False
        if ours:
            print(f"TubeFactory уже запущен: {url}\n"
                  "Чтобы запустить новую версию, закройте старое окно (Ctrl+C) и запустите снова.")
            if not args.no_browser:
                webbrowser.open(url)
        else:
            print(f"Порт {args.port} занят другой программой. Запустите так: py run.py --port 8001")
        sys.exit(1)
    if not args.no_browser:
        webbrowser.open(url)
    uvicorn.run("app.server:app", host=args.host, port=args.port)
