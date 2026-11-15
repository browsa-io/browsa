"""Minimal Flask webhook receiver that verifies signatures.

Run:
    export BROWSA_WEBHOOK_SECRET=$(curl -s -H "X-API-Key: $BROWSA_API_KEY" \
        https://browsa.io/v1/webhooks/signing-secret | jq -r .secret)
    pip install flask browsa
    python webhook_receiver.py
    # In another shell, register a webhook pointing at your ngrok URL.
"""
import json
import os

from flask import Flask, request, jsonify
from browsa import webhooks

SECRET = os.environ["BROWSA_WEBHOOK_SECRET"]  # hex-encoded
app = Flask(__name__)


@app.post("/webhook")
def receive():
    raw = request.get_data()  # MUST be raw bytes BEFORE any parsing
    sig = request.headers.get("X-Agents-Signature", "")
    if not webhooks.verify_signature(raw, sig, SECRET):
        return jsonify({"error": "bad signature"}), 401

    payload = json.loads(raw)
    # job_id, job_kind, agent_id and error_code sit at the top level of the event.
    print(f"event={payload.get('type')} job={payload.get('job_id')} error={payload.get('error_code')}")
    return "", 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
