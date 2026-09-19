"""Thin wrapper around the Upstash Redis REST API (used via Vercel KV).

Requires KV_REST_API_URL and KV_REST_API_TOKEN env vars, which Vercel
injects automatically once a KV/Redis storage integration is attached
to the project.
"""
import json
import os
import urllib.request

KV_URL = os.environ.get("KV_REST_API_URL", "")
KV_TOKEN = os.environ.get("KV_REST_API_TOKEN", "")


def _request(path, method="GET", body=None):
    if not KV_URL or not KV_TOKEN:
        raise RuntimeError("KV_REST_API_URL / KV_REST_API_TOKEN are not configured")
    req = urllib.request.Request(
        f"{KV_URL}{path}",
        data=body.encode() if body is not None else None,
        method=method,
        headers={"Authorization": f"Bearer {KV_TOKEN}"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read())


def get_json(key):
    result = _request(f"/get/{key}")
    val = result.get("result")
    return json.loads(val) if val else None


def set_json(key, value):
    _request(f"/set/{key}", method="POST", body=json.dumps(value))


def delete(key):
    _request(f"/del/{key}", method="POST")


def sadd(set_key, member):
    _request(f"/sadd/{set_key}/{member}", method="POST")


def srem(set_key, member):
    _request(f"/srem/{set_key}/{member}", method="POST")


def smembers(set_key):
    result = _request(f"/smembers/{set_key}")
    return result.get("result") or []
