"""Vercel Cron target: once a day, push a notification for anything due tomorrow.

Each stored subscription keeps its own "notified" list so an assignment is
only pushed once, no matter how many times this runs before its due date.
"""
import json
import os
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler
from zoneinfo import ZoneInfo

from pywebpush import WebPushException, webpush

from _kv import delete, get_json, set_json, smembers, srem

SUBS_SET = "hw:subs"
TIMEZONE = "Asia/Saigon"
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:longdoan0311@gmail.com")
CRON_SECRET = os.environ.get("CRON_SECRET", "")


def run():
    tomorrow = (datetime.now(ZoneInfo(TIMEZONE)) + timedelta(days=1)).strftime("%Y-%m-%d")
    sent = 0

    for sub_id in smembers(SUBS_SET):
        key = f"hw:sub:{sub_id}"
        record = get_json(key)
        if not record:
            srem(SUBS_SET, sub_id)
            continue

        items = record.get("items", [])
        notified = set(record.get("notified", []))
        due = [i for i in items if i.get("dueDate") == tomorrow and i.get("id") not in notified]
        if not due:
            continue

        body = (
            due[0]["title"]
            if len(due) == 1
            else f"{len(due)} assignments: " + ", ".join(i["title"] for i in due)
        )

        try:
            webpush(
                subscription_info=record["subscription"],
                data=json.dumps({"title": "Homework due tomorrow", "body": body}),
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims={"sub": VAPID_SUBJECT},
            )
            sent += 1
            notified.update(i["id"] for i in due)
            record["notified"] = list(notified)
            set_json(key, record)
        except WebPushException as e:
            status = getattr(e.response, "status_code", None)
            if status in (404, 410):
                delete(key)
                srem(SUBS_SET, sub_id)

    return sent


class handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if CRON_SECRET:
            auth = self.headers.get("Authorization", "")
            if auth != f"Bearer {CRON_SECRET}":
                self.send_response(401)
                self.end_headers()
                return
        try:
            sent = run()
            body = json.dumps({"ok": True, "sent": sent}).encode()
            status = 200
        except Exception as e:
            body = json.dumps({"ok": False, "error": str(e)}).encode()
            status = 500
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
