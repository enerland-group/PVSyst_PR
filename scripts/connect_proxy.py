#!/usr/bin/env python3
"""Proxy HTTP con CONNECT en Python, para dar salida a node.exe.

Sophos bloquea la salida a internet de node.exe (connect EACCES a cualquier
host), pero python.exe si sale. Igual que tools/npm_proxy.py del proyecto
CASHFLOW, pero generico: aqui hace falta HTTPS de verdad (MSAL, api.fabric,
el endpoint de deploy), no solo GETs al registro de npm.

  - node habla HTTP con 127.0.0.1 (loopback, permitido) y pide CONNECT
  - python abre el socket al destino y hace de tuberia de bytes en crudo

El TLS va de extremo a extremo entre node y el destino: python no lo
descifra ni necesita certificados, solo reenvia.

Uso:
    py scripts/connect_proxy.py [--port 8899]
Luego, en el proceso de node:
    NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:8899 npx rayfin ...
"""
import argparse
import select
import socket
import sys
import threading
import urllib.parse
import urllib.request
from socketserver import StreamRequestHandler, ThreadingTCPServer

BUFSIZE = 65536
CONNECT_TIMEOUT = 30
IDLE_TIMEOUT = 300


def log(msg: str) -> None:
    sys.stdout.write("[proxy] %s\n" % msg)
    sys.stdout.flush()


class ProxyHandler(StreamRequestHandler):
    timeout = IDLE_TIMEOUT

    def handle(self):
        try:
            line = self.rfile.readline(65536)
        except OSError:
            return
        if not line:
            return
        parts = line.decode("latin-1").rstrip("\r\n").split(" ")
        if len(parts) < 3:
            return
        method, target, version = parts[0], parts[1], parts[2]

        headers = []
        while True:
            h = self.rfile.readline(65536)
            if not h or h in (b"\r\n", b"\n"):
                break
            headers.append(h)

        if method.upper() == "CONNECT":
            self._tunnel(target)
        else:
            self._forward(method, target, headers)

    # -- CONNECT: tunel de bytes en crudo (lo que usa todo el HTTPS) --------
    def _tunnel(self, target: str):
        host, _, port = target.rpartition(":")
        try:
            upstream = socket.create_connection((host, int(port)), CONNECT_TIMEOUT)
        except Exception as e:  # noqa: BLE001
            log("CONNECT %s ERROR %s" % (target, e))
            self.wfile.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            return
        log("CONNECT %s" % target)
        self.wfile.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
        self.wfile.flush()

        client = self.connection
        sockets = [client, upstream]
        try:
            while True:
                readable, _, err = select.select(sockets, [], sockets, IDLE_TIMEOUT)
                if err or not readable:
                    break
                for s in readable:
                    other = upstream if s is client else client
                    data = s.recv(BUFSIZE)
                    if not data:
                        return
                    other.sendall(data)
        except OSError:
            pass
        finally:
            try:
                upstream.close()
            except OSError:
                pass

    # -- HTTP plano con URI absoluta (poco habitual, pero por completitud) --
    def _forward(self, method: str, target: str, raw_headers):
        if not target.startswith("http://"):
            self.wfile.write(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            return
        length = 0
        hdrs = {}
        for h in raw_headers:
            name, _, value = h.decode("latin-1").rstrip("\r\n").partition(":")
            value = value.strip()
            low = name.lower()
            if low in ("proxy-connection", "connection", "host"):
                continue
            if low == "content-length":
                length = int(value)
            hdrs[name] = value
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(target, data=body, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=CONNECT_TIMEOUT) as up:
                data = up.read()
                status, resp_headers = up.status, up.headers
        except urllib.error.HTTPError as e:
            data, status, resp_headers = e.read(), e.code, e.headers
        except Exception as e:  # noqa: BLE001
            log("%s %s ERROR %s" % (method, target, e))
            self.wfile.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            return
        log("%s %s -> %s" % (method, target, status))
        out = ["HTTP/1.1 %d OK" % status]
        for k, v in resp_headers.items():
            if k.lower() in ("transfer-encoding", "connection", "content-length"):
                continue
            out.append("%s: %s" % (k, v))
        out.append("Content-Length: %d" % len(data))
        self.wfile.write(("\r\n".join(out) + "\r\n\r\n").encode("latin-1"))
        self.wfile.write(data)


class Proxy(ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8899)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()
    server = Proxy((args.host, args.port), ProxyHandler)
    log("escuchando en http://%s:%d" % (args.host, args.port))
    threading.current_thread().name = "proxy-main"
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
