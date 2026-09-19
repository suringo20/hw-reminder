"""Registers/updates a browser's push subscription and its pending homework.

Called by the client (see static/script.js) whenever the push subscription
is (re)created or the homework list changes, so the daily reminder cron has
a fresh view of what's due without needing any login.
"""
import hashlib
import json
from http.server import BaseHTTPRequestHandler

from _kv import get_json, sadd, set_json

SUBS_SET = "hw:subs"


def _json_response(handler, status, payload):
    body = json.dumps(payload).encode()
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class handler(BaseHTTPRequestHandler):
    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(length))
            subscription = data["subscription"]
            items = data.get("items", [])
            day_offsets = data.get("dayOffsets", [])
            endpoint = subscription["endpoint"]

            sub_id = hashlib.sha256(endpoint.encode()).hexdigest()[:32]
            key = f"hw:sub:{sub_id}"

            existing = get_json(key) or {}
            notified = existing.get("notified", [])

            set_json(key, {
                "subscription": subscription,
                "items": items,
                "dayOffsets": day_offsets,
                "notified": notified,
            })
            sadd(SUBS_SET, sub_id)

            _json_response(self, 200, {"ok": True})
        except Exception as e:
            _json_response(self, 500, {"error": str(e)})
