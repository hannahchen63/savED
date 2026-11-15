"""
Local server for the Gentle Feed extension.

POST /classify  {"text": "...", "threshold": 0.4, "strict": true/false}
  -> {"blur": true/false, "score": ..., "ed_score": ..., "diet_score": ...,
      "reason": "ed" / "diet" / null, "mode": ...}

Layer 1 (always on): the eating disorder model in server/ed_model/
    (or a keyword placeholder if that folder is missing).
Layer 2 (strict mode, toggled in the extension popup): the diet-culture
    model in server/diet_model/ (an embedder + a classifier). Catches
    weight-loss and low-calorie posts that layer 1 treats as harmless recipes.
"""

import glob
import os
import re

from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

HERE = os.path.dirname(os.path.abspath(__file__))
ED_DIR = os.path.join(HERE, "ed_model")
DIET_DIR = os.path.join(HERE, "diet_model")

DEFAULT_THRESHOLD = 0.4   # layer 1 cutoff
DIET_THRESHOLD = 0.5      # layer 2 cutoff


# Clean captions exactly the way the training data was cleaned.
def clean(text):
    text = re.sub(r"^RT\s+", "", text)
    text = re.sub(r"@\w+", "@user", text)
    text = re.sub(r"http\S+", "", text)
    return re.sub(r"\s+", " ", text).strip()


# Split a caption into its paragraphs (separated by blank lines), cleaned.
# Very short pieces are skipped: the diet model gives unreliable scores
# to tiny bits of text. At most 8 paragraphs, to keep it fast.
MIN_PARAGRAPH_CHARS = 20
MAX_PARAGRAPHS = 8


def paragraphs(raw):
    parts = [clean(p) for p in re.split(r"\n\s*\n", raw)]
    parts = [p for p in parts if len(p) >= MIN_PARAGRAPH_CHARS]
    if len(parts) < 2:
        return []  # only one paragraph: the whole caption is already scored
    return parts[:MAX_PARAGRAPHS]


# =========================================================================
# Layer 1: eating disorder model
# =========================================================================
tokenizer = model = None
if os.path.isdir(ED_DIR):
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(ED_DIR)
    model = AutoModelForSequenceClassification.from_pretrained(ED_DIR)
    model.eval()
    print(f"[layer 1] Loaded model from {ED_DIR}")
    print("[layer 1] Labels:", model.config.id2label, "(index 1 should be harmful)")
else:
    print("[layer 1] No ed_model/ folder found. Using keyword PLACEHOLDER.")


def model_score(text):
    inputs = tokenizer(text, truncation=True, max_length=128, return_tensors="pt")
    with torch.no_grad():
        logits = model(**inputs).logits
    return float(torch.softmax(logits, dim=-1)[0][1])


PLACEHOLDER_PHRASES = [
    "thinspo", "pro ana", "meanspo", "goal weight", "skip meals",
    "skipped meals", "fasting challenge", "calorie deficit",
]


def placeholder_score(text):
    t = text.lower()
    return 0.9 if any(p in t for p in PLACEHOLDER_PHRASES) else 0.1


# =========================================================================
# Layer 2: diet-culture model (strict mode)
# Looks inside server/diet_model/ for:
#   - a classifier saved with joblib (any .joblib or .pkl file)
#   - an embedder that turns text into numbers: a saved
#     sentence-transformers folder, a saved Hugging Face model folder,
#     or the embedder's name written in a .txt file or in the joblib file
# =========================================================================
diet_clf = None        # the classifier (LogisticRegression or a Pipeline)
diet_embedder = None   # function: text -> list of numbers (None for Pipelines)


def _find_classifier():
    files = sorted(glob.glob(os.path.join(DIET_DIR, "**", "*.joblib"), recursive=True)
                   + glob.glob(os.path.join(DIET_DIR, "**", "*.pkl"), recursive=True))
    if not files:
        raise FileNotFoundError("no .joblib or .pkl file inside diet_model/")
    import joblib

    obj = joblib.load(files[0])
    print(f"[layer 2] Classifier file: {os.path.relpath(files[0], HERE)}")
    embedder_name = None
    if isinstance(obj, dict):  # some notebooks save {"clf": ..., "embedder": "name"}
        for k, v in obj.items():
            if isinstance(v, str) and ("embed" in k.lower() or "model" in k.lower()):
                embedder_name = v
        obj = next(v for v in obj.values() if hasattr(v, "predict"))
    return obj, embedder_name


def _load_sentence_folder_directly(folder):
    """Rebuild a saved sentence-transformers embedder using only transformers:
    the base model, then the pooling step (1_Pooling), then normalizing
    (2_Normalize) if it's there. Gives the same numbers as the library."""
    import json

    import torch
    from transformers import AutoModel, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(folder)
    enc = AutoModel.from_pretrained(folder)
    enc.eval()

    max_len = 256
    cfg_path = os.path.join(folder, "sentence_bert_config.json")
    if os.path.isfile(cfg_path):
        with open(cfg_path) as f:
            max_len = json.load(f).get("max_seq_length", max_len) or max_len

    pooling = "mean"
    normalize = False
    for sub in sorted(os.listdir(folder)):
        sub_path = os.path.join(folder, sub)
        if not os.path.isdir(sub_path):
            continue
        if sub.endswith("Pooling") and os.path.isfile(os.path.join(sub_path, "config.json")):
            with open(os.path.join(sub_path, "config.json")) as f:
                pc = json.load(f)
            if pc.get("pooling_mode_cls_token"):
                pooling = "cls"
            elif pc.get("pooling_mode_max_tokens"):
                pooling = "max"
            elif pc.get("pooling_mode") in ("cls", "max", "mean"):
                pooling = pc["pooling_mode"]
        if sub.endswith("Normalize"):
            normalize = True

    def embed(text):
        inputs = tok(text, truncation=True, max_length=max_len, return_tensors="pt")
        with torch.no_grad():
            out = enc(**inputs).last_hidden_state
        mask = inputs["attention_mask"].unsqueeze(-1).float()
        if pooling == "cls":
            vec = out[:, 0]
        elif pooling == "max":
            vec = out.masked_fill(mask == 0, -1e9).max(1).values
        else:
            vec = (out * mask).sum(1) / mask.sum(1).clamp(min=1e-9)
        if normalize:
            vec = torch.nn.functional.normalize(vec, p=2, dim=1)
        return vec[0].numpy()

    print(f"[layer 2] Embedder: {os.path.relpath(folder, HERE)} loaded directly "
          f"({pooling} pooling{', normalized' if normalize else ''})")
    return embed


def _find_embedder(name_hint):
    # 1. A saved sentence-transformers folder has a modules.json file
    for path in glob.glob(os.path.join(DIET_DIR, "**", "modules.json"), recursive=True):
        folder = os.path.dirname(path)
        try:
            from sentence_transformers import SentenceTransformer

            st = SentenceTransformer(folder)
            print(f"[layer 2] Embedder: sentence-transformers folder {os.path.relpath(folder, HERE)}")
            return lambda text: st.encode([text])[0]
        except Exception as e:
            # Usually a version mismatch with the library. Load the same
            # files directly with transformers instead.
            print(f"[layer 2] sentence-transformers couldn't load it ({type(e).__name__}); "
                  "loading the files directly instead")
            return _load_sentence_folder_directly(folder)

    # 2. A saved Hugging Face model folder has a config.json file
    for path in glob.glob(os.path.join(DIET_DIR, "**", "config.json"), recursive=True):
        import torch
        from transformers import AutoModel, AutoTokenizer

        folder = os.path.dirname(path)
        tok = AutoTokenizer.from_pretrained(folder)
        enc = AutoModel.from_pretrained(folder)
        enc.eval()
        print(f"[layer 2] Embedder: Hugging Face folder {os.path.relpath(folder, HERE)} (mean pooling)")

        def embed(text):
            inputs = tok(text, truncation=True, max_length=256, return_tensors="pt")
            with torch.no_grad():
                out = enc(**inputs).last_hidden_state
            mask = inputs["attention_mask"].unsqueeze(-1)
            return ((out * mask).sum(1) / mask.sum(1))[0].numpy()

        return embed

    # 3. The embedder's name, from the joblib file or a .txt file
    name = name_hint
    if not name:
        for path in glob.glob(os.path.join(DIET_DIR, "**", "*.txt"), recursive=True):
            with open(path) as f:
                name = f.read().strip()
            if name:
                break
    if name:
        from sentence_transformers import SentenceTransformer

        st = SentenceTransformer(name)  # downloads once, then cached
        print(f"[layer 2] Embedder: sentence-transformers model '{name}'")
        return lambda text: st.encode([text])[0]

    raise FileNotFoundError("could not find the embedder inside diet_model/")


def diet_score(text):
    """Probability (0 to 1) that the text is diet-culture content."""
    if diet_embedder is None:          # a Pipeline that reads raw text itself
        features = [text]
    else:
        features = [diet_embedder(text)]

    if hasattr(diet_clf, "predict_proba"):
        probs = diet_clf.predict_proba(features)[0]
        classes = list(diet_clf.classes_)
        positive = 1 if 1 in classes else (True if True in classes else classes[-1])
        return float(probs[classes.index(positive)])
    return 1.0 if diet_clf.predict(features)[0] in (1, True) else 0.0


if os.path.isdir(DIET_DIR):
    try:
        diet_clf, name_hint = _find_classifier()
        if hasattr(diet_clf, "steps"):
            print("[layer 2] Classifier is a full pipeline (reads text directly)")
        else:
            diet_embedder = _find_embedder(name_hint)
            expected = getattr(diet_clf, "n_features_in_", None)
            got = len(diet_embedder("test"))
            if expected and expected != got:
                raise ValueError(f"embedder makes {got} numbers but classifier expects "
                                 f"{expected}. They don't match.")
        print("[layer 2] Classes:", list(getattr(diet_clf, "classes_", [])), "(1 should be diet)")
        test = "Low Calorie High Protein Cookie Dough 266 calories #fatlossrecipes"
        print(f"[layer 2] Test score: {diet_score(test):.3f} (should be above 0.5)")
        print("[layer 2] READY: strict mode is available")
    except Exception as e:
        print("[layer 2] FAILED to load diet_model/:", repr(e))
        print("[layer 2] Strict mode will do nothing. Send this message for help.")
        diet_clf = diet_embedder = None
else:
    print("[layer 2] No diet_model/ folder found. Strict mode will do nothing.")


# =========================================================================
# Routes
# =========================================================================
@app.route("/health")
def health():
    return jsonify({
        "ok": True,
        "mode": "model" if model else "placeholder",
        "strict_layer": "loaded" if diet_clf is not None else "missing",
    })


@app.route("/classify", methods=["POST"])
def classify():
    data = request.get_json(silent=True) or {}
    raw = str(data.get("text", ""))
    text = clean(raw)
    strict = bool(data.get("strict", False))
    try:
        threshold = float(data.get("threshold", DEFAULT_THRESHOLD))
    except (TypeError, ValueError):
        threshold = DEFAULT_THRESHOLD

    if not text:
        return jsonify({"blur": False, "score": 0.0, "mode": "empty"})

    # Layer 1
    if model:
        ed, mode = model_score(text), "model"
    else:
        ed, mode = placeholder_score(text), "placeholder"

    # Layer 2 (only in strict mode). Scores the whole caption AND each
    # paragraph on its own, and keeps the highest. A diet line like
    # "macros: 275 cal | 30g protein" then isn't drowned out by a long recipe.
    diet = None
    if strict and diet_clf is not None:
        diet = diet_score(text)
        for part in paragraphs(raw):
            diet = max(diet, diet_score(part))

    reason = None
    if ed >= threshold:
        reason = "ed"
    elif diet is not None and diet >= DIET_THRESHOLD:
        reason = "diet"

    return jsonify({
        "blur": reason is not None,
        "score": round(max(ed, diet or 0.0), 4),
        "ed_score": round(ed, 4),
        "diet_score": None if diet is None else round(diet, 4),
        "reason": reason,
        "mode": mode,
    })


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=True)
