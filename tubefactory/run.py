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
    ap.add_argument("--remote", action="store_true",
                    help="also open to other devices (phone via Tailscale or Wi-Fi); they need the Settings password")
    args = ap.parse_args()
    if args.remote:
        args.host = "0.0.0.0"
    url = f"http://{'127.0.0.1' if args.remote else args.host}:{args.port}"
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
    print(f"TubeFactory работает: {url}  (остановить: Ctrl+C)")
    if args.remote:
        names = {socket.gethostname()}
        try:
            names |= {ip for *_, (ip, *_) in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)}
        except OSError:
            pass
        print("С телефона (через Tailscale или ту же Wi-Fi) откройте:")
        for n in sorted(n for n in names if not n.startswith("127.")):
            print(f"   http://{n}:{args.port}")
        print("Вход — пароль из Настройки → «Пароль для входа с телефона». IP 100.x.x.x — это Tailscale.")
    # Access log off: the UI polls every few seconds and would flood the window.
    uvicorn.run("app.server:app", host=args.host, port=args.port, access_log=False)
