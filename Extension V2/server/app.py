"""
Local server for the Gentle Feed extension.

POST /classify  {"text": "...", "threshold": 0.4}
  -> {"blur": true/false, "score": 0.0-1.0, "mode": "model" or "placeholder"}

If server/ed_model/ exists, it uses the trained model.
If not, it uses a simple keyword placeholder so the extension can be built now.
"""

import os
import re

from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

MODEL_DIR = os.path.join(os.path.dirname(__file__), "ed_model")
DEFAULT_THRESHOLD = 0.4


# Clean captions exactly the way the training data was cleaned.
def clean(text):
    text = re.sub(r"^RT\s+", "", text)
    text = re.sub(r"@\w+", "@user", text)
    text = re.sub(r"http\S+", "", text)
    return re.sub(r"\s+", " ", text).strip()


# ---- Load the real model if it's there --------------------------------
tokenizer = model = None
if os.path.isdir(MODEL_DIR):
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
    model = AutoModelForSequenceClassification.from_pretrained(MODEL_DIR)
    model.eval()
    print(f"Loaded model from {MODEL_DIR}")
    print("Labels:", model.config.id2label, "(index 1 should be harmful)")
else:
    print("No ed_model/ folder found. Using keyword PLACEHOLDER.")


def model_score(text):
    inputs = tokenizer(text, truncation=True, max_length=128, return_tensors="pt")
    with torch.no_grad():
        logits = model(**inputs).logits
    return float(torch.softmax(logits, dim=-1)[0][1])


# Placeholder until the model arrives. Deliberately crude.
PLACEHOLDER_PHRASES = [
    "thinspo", "pro ana", "meanspo", "goal weight", "skip meals",
    "skipped meals", "fasting challenge", "calorie deficit",
]


def placeholder_score(text):
    t = text.lower()
    return 0.9 if any(p in t for p in PLACEHOLDER_PHRASES) else 0.1


# ---- Routes -------------------------------------------------------------
@app.route("/health")
def health():
    return jsonify({"ok": True, "mode": "model" if model else "placeholder"})


@app.route("/classify", methods=["POST"])
def classify():
    data = request.get_json(silent=True) or {}
    text = clean(str(data.get("text", "")))
    try:
        threshold = float(data.get("threshold", DEFAULT_THRESHOLD))
    except (TypeError, ValueError):
        threshold = DEFAULT_THRESHOLD

    if not text:
        return jsonify({"blur": False, "score": 0.0, "mode": "empty"})

    if model:
        score, mode = model_score(text), "model"
    else:
        score, mode = placeholder_score(text), "placeholder"

    return jsonify({"blur": score >= threshold, "score": round(score, 4), "mode": mode})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)
