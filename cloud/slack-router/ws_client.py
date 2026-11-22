#!/usr/bin/env python3
"""Minimal RFC 6455 WebSocket client using Python stdlib only."""

from __future__ import annotations

import base64
import hashlib
import os
import socket
import ssl
import struct
import urllib.parse
from typing import Optional

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WebSocketError(RuntimeError):
    """Raised on WebSocket protocol or transport errors."""


class SimpleWebSocket:
    def __init__(self, sock: socket.socket) -> None:
        self._sock = sock
        self._closed = False
        self._buffer = bytearray()

    @classmethod
    def connect(
        cls,
        url: str,
        *,
        timeout: float = 15.0,
        headers: Optional[dict[str, str]] = None,
    ) -> "SimpleWebSocket":
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ("ws", "wss"):
            raise ValueError(f"Unsupported WebSocket scheme: {parsed.scheme}")
        host = parsed.hostname
        if not host:
            raise ValueError(f"Missing host in WebSocket URL: {url}")
        port = parsed.port or (443 if parsed.scheme == "wss" else 80)
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"

        raw_sock = socket.create_connection((host, port), timeout=timeout)
        try:
            sock: socket.socket
            if parsed.scheme == "wss":
                ctx = ssl.create_default_context()
                sock = ctx.wrap_socket(raw_sock, server_hostname=host)
            else:
                sock = raw_sock
            sock.settimeout(timeout)

            ws_key = base64.b64encode(os.urandom(16)).decode("ascii")
            host_hdr = f"{host}:{port}" if parsed.port else host
            req_lines = [
                f"GET {path} HTTP/1.1",
                f"Host: {host_hdr}",
                "Upgrade: websocket",
                "Connection: Upgrade",
                f"Sec-WebSocket-Key: {ws_key}",
                "Sec-WebSocket-Version: 13",
            ]
            for k, v in (headers or {}).items():
                req_lines.append(f"{k}: {v}")
            req_lines.extend(["", ""])
            sock.sendall("\r\n".join(req_lines).encode("ascii"))

            buf = bytearray()
            while b"\r\n\r\n" not in buf:
                chunk = sock.recv(4096)
                if not chunk:
                    raise WebSocketError("Connection closed during WebSocket handshake")
                buf.extend(chunk)
                if len(buf) > 65536:
                    raise WebSocketError("WebSocket handshake response too large")

            header_end = buf.index(b"\r\n\r\n") + 4
            header_raw = bytes(buf[:header_end]).decode("latin-1")
            leftover = bytearray(buf[header_end:])
            lines = header_raw.split("\r\n")
            if not lines or "101" not in lines[0]:
                raise WebSocketError(f"WebSocket handshake failed: {lines[0] if lines else ''}")

            resp_headers: dict[str, str] = {}
            for line in lines[1:]:
                if ":" in line:
                    k, v = line.split(":", 1)
                    resp_headers[k.strip().lower()] = v.strip()

            expected_accept = base64.b64encode(
                hashlib.sha1((ws_key + _WS_GUID).encode("ascii")).digest()
            ).decode("ascii")
            if resp_headers.get("sec-websocket-accept") != expected_accept:
                raise WebSocketError("Invalid Sec-WebSocket-Accept header")

            ws = cls(sock)
            ws._buffer = leftover
            return ws
        except Exception:
            try:
                raw_sock.close()
            except Exception:
                pass
            raise

    def settimeout(self, timeout: Optional[float]) -> None:
        self._sock.settimeout(timeout)

    def _read_exact(self, n: int) -> bytes:
        while len(self._buffer) < n:
            chunk = self._sock.recv(max(4096, n - len(self._buffer)))
            if not chunk:
                raise WebSocketError("EOF while reading WebSocket frame")
            self._buffer.extend(chunk)
        out = bytes(self._buffer[:n])
        del self._buffer[:n]
        return out

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        if self._closed:
            raise WebSocketError("WebSocket already closed")
        mask = os.urandom(4)
        length = len(payload)
        header = bytearray([0x80 | (opcode & 0x0F)])
        if length < 126:
            header.append(0x80 | length)
        elif length <= 0xFFFF:
            header.append(0x80 | 126)
            header.extend(struct.pack("!H", length))
        else:
            header.append(0x80 | 127)
            header.extend(struct.pack("!Q", length))
        header.extend(mask)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self._sock.sendall(bytes(header) + masked)

    def send_text(self, text: str) -> None:
        self._send_frame(0x1, text.encode("utf-8"))

    def send_pong(self, payload: bytes = b"") -> None:
        self._send_frame(0xA, payload[:125])

    def _read_frame(self) -> tuple[bool, int, bytes]:
        b1, b2 = struct.unpack("!BB", self._read_exact(2))
        fin = bool(b1 & 0x80)
        opcode = b1 & 0x0F
        masked = bool(b2 & 0x80)
        length = b2 & 0x7F
        if length == 126:
            (length,) = struct.unpack("!H", self._read_exact(2))
        elif length == 127:
            (length,) = struct.unpack("!Q", self._read_exact(8))
        if length > 16 * 1024 * 1024:
            raise WebSocketError(f"Frame payload too large: {length}")
        mask = self._read_exact(4) if masked else b""
        payload = self._read_exact(length) if length else b""
        if masked:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        return fin, opcode, payload

    def recv_text(self, timeout: Optional[float] = None) -> Optional[str]:
        if self._closed:
            return None
        if timeout is not None:
            self._sock.settimeout(timeout)
        fragments: list[bytes] = []
        expecting_cont = False
        while True:
            fin, opcode, payload = self._read_frame()
            if opcode == 0x9:  # ping
                try:
                    self.send_pong(payload)
                except Exception:
                    pass
                continue
            if opcode == 0xA:  # pong
                continue
            if opcode == 0x8:  # close
                self._closed = True
                return None
            if opcode in (0x1, 0x2):
                fragments = [payload]
                if fin:
                    return b"".join(fragments).decode("utf-8", errors="replace")
                expecting_cont = True
                continue
            if opcode == 0x0 and expecting_cont:
                fragments.append(payload)
                if fin:
                    return b"".join(fragments).decode("utf-8", errors="replace")
                continue
            raise WebSocketError(f"Unexpected WebSocket opcode: {opcode}")

    def close(self) -> None:
        if self._closed:
            return
        try:
            self._send_frame(0x8, b"")
        except Exception:
            pass
        self._closed = True
        try:
            self._sock.close()
        except Exception:
            pass
