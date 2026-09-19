"""Vercel Cron target: once a day, push a notification for anything due
in N days, for each day-offset (1 day, 2 days, ...) a subscription picked.

Minute/hour-level offsets ("5 minutes before", "1 hour before", "right when
due") can't be handled here -- Vercel's free-tier cron only runs once a day,
so those stay in-app-only (see checkReminders() in static/script.js).

Each stored subscription keeps its own "notified" list, keyed by
"<item id>:<offset minutes>", so a given (item, offset) pair is only
pushed once no matter how many days this runs before the item is due.
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
    now = datetime.now(ZoneInfo(TIMEZONE))
    sent = 0

    for sub_id in smembers(SUBS_SET):
        key = f"hw:sub:{sub_id}"
        record = get_json(key)
        if not record:
            srem(SUBS_SET, sub_id)
            continue

        items = record.get("items", [])
        day_offsets = record.get("dayOffsets", [])
        notified = set(record.get("notified", []))
        dirty = False
        unsubscribed = False

        for offset in day_offsets:
            days = offset // 1440
            if offset % 1440 != 0 or days <= 0:
                continue
            target_date = (now + timedelta(days=days)).strftime("%Y-%m-%d")
            due = [
                i for i in items
                if i.get("dueDate") == target_date and f"{i.get('id')}:{offset}" not in notified
            ]
            if not due:
                continue

            when = "tomorrow" if days == 1 else f"in {days} days"
            body = (
                due[0]["title"]
                if len(due) == 1
                else f"{len(due)} assignments: " + ", ".join(i["title"] for i in due)
            )

            try:
                webpush(
                    subscription_info=record["subscription"],
                    data=json.dumps({"title": f"Homework due {when}", "body": body}),
                    vapid_private_key=VAPID_PRIVATE_KEY,
                    vapid_claims={"sub": VAPID_SUBJECT},
                )
                sent += 1
                notified.update(f"{i['id']}:{offset}" for i in due)
                dirty = True
            except WebPushException as e:
                status = getattr(e.response, "status_code", None)
                if status in (404, 410):
                    delete(key)
                    srem(SUBS_SET, sub_id)
                    unsubscribed = True
                break

        if unsubscribed:
            continue
        if dirty:
            record["notified"] = list(notified)
            set_json(key, record)

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
