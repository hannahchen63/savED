"""
Local server for the extension.

POST /classify        {"text": "..."}
POST /classify_batch  {"texts": ["...", "..."]}
  -> {"blur": true/false, "score": ..., "diet_score": ..., "reason": "diet"/null}

One model: the diet-culture model in server/diet_model/ (an embedder + a
classifier). It checks every post. (The earlier eating disorder model,
"layer 1", has been removed and is not loaded.)
"""

import glob
import os
import re

from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

HERE = os.path.dirname(os.path.abspath(__file__))
DIET_DIR = os.path.join(HERE, "diet_model")

DIET_THRESHOLD = 0.5      # blur at or above this diet score


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
# The diet-culture model
# Looks inside server/diet_model/ for:
#   - a classifier saved with joblib (any .joblib or .pkl file)
#   - an embedder that turns text into numbers: a saved
#     sentence-transformers folder, a saved Hugging Face model folder,
#     or the embedder's name written in a .txt file or in the joblib file
# =========================================================================
diet_clf = None        # the classifier (LogisticRegression or a Pipeline)
diet_embedder = None   # function: list of texts -> numbers for each (None for Pipelines)


def _find_classifier():
    files = sorted(glob.glob(os.path.join(DIET_DIR, "**", "*.joblib"), recursive=True)
                   + glob.glob(os.path.join(DIET_DIR, "**", "*.pkl"), recursive=True))
    if not files:
        raise FileNotFoundError("no .joblib or .pkl file inside diet_model/")
    import joblib

    obj = joblib.load(files[0])
    print(f"[diet model] Classifier file: {os.path.relpath(files[0], HERE)}")
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

    def embed(texts):
        inputs = tok(list(texts), truncation=True, max_length=max_len,
                     padding=True, return_tensors="pt")
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
        return vec.numpy()

    print(f"[diet model] Embedder: {os.path.relpath(folder, HERE)} loaded directly "
          f"({pooling} pooling{', normalized' if normalize else ''})")
    return embed


def _find_embedder(name_hint):
    # 1. A saved sentence-transformers folder has a modules.json file
    for path in glob.glob(os.path.join(DIET_DIR, "**", "modules.json"), recursive=True):
        folder = os.path.dirname(path)
        try:
            from sentence_transformers import SentenceTransformer

            st = SentenceTransformer(folder)
            print(f"[diet model] Embedder: sentence-transformers folder {os.path.relpath(folder, HERE)}")
            return lambda texts: st.encode(list(texts))
        except Exception as e:
            # Usually a version mismatch with the library. Load the same
            # files directly with transformers instead.
            print(f"[diet model] sentence-transformers couldn't load it ({type(e).__name__}); "
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
        print(f"[diet model] Embedder: Hugging Face folder {os.path.relpath(folder, HERE)} (mean pooling)")

        def embed(texts):
            inputs = tok(list(texts), truncation=True, max_length=256,
                         padding=True, return_tensors="pt")
            with torch.no_grad():
                out = enc(**inputs).last_hidden_state
            mask = inputs["attention_mask"].unsqueeze(-1).float()
            return ((out * mask).sum(1) / mask.sum(1).clamp(min=1e-9)).numpy()

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
        print(f"[diet model] Embedder: sentence-transformers model '{name}'")
        return lambda texts: st.encode(list(texts))

    raise FileNotFoundError("could not find the embedder inside diet_model/")


def diet_scores(texts):
    """Probability (0 to 1) that each text is diet-culture content, in one pass."""
    texts = list(texts)
    if not texts:
        return []
    if diet_embedder is None:          # a Pipeline that reads raw text itself
        features = texts
    else:
        features = diet_embedder(texts)

    if hasattr(diet_clf, "predict_proba"):
        probs = diet_clf.predict_proba(features)
        classes = list(diet_clf.classes_)
        positive = 1 if 1 in classes else (True if True in classes else classes[-1])
        col = classes.index(positive)
        return [float(p[col]) for p in probs]
    return [1.0 if p in (1, True) else 0.0 for p in diet_clf.predict(features)]


def diet_score(text):
    return diet_scores([text])[0]


if os.path.isdir(DIET_DIR):
    try:
        diet_clf, name_hint = _find_classifier()
        if hasattr(diet_clf, "steps"):
            print("[diet model] Classifier is a full pipeline (reads text directly)")
        else:
            diet_embedder = _find_embedder(name_hint)
            expected = getattr(diet_clf, "n_features_in_", None)
            got = len(diet_embedder(["test"])[0])
            if expected and expected != got:
                raise ValueError(f"embedder makes {got} numbers but classifier expects "
                                 f"{expected}. They don't match.")
        print("[diet model] Classes:", list(getattr(diet_clf, "classes_", [])), "(1 should be diet)")
        test = "Low Calorie High Protein Cookie Dough 266 calories #fatlossrecipes"
        print(f"[diet model] Test score: {diet_score(test):.3f} (should be above 0.5)")
        print("[diet model] READY")
    except Exception as e:
        print("[diet model] FAILED to load diet_model/:", repr(e))
        print("[diet model] Strict mode will do nothing. Send this message for help.")
        diet_clf = diet_embedder = None
else:
    print("[diet model] No diet_model/ folder found. Strict mode will do nothing.")


# =========================================================================
# Routes
# =========================================================================
@app.route("/health")
def health():
    return jsonify({
        "ok": True,
        "diet_model": "loaded" if diet_clf is not None else "missing",
    })


def score_many(raws):
    """Score many captions together: the diet model runs once over all
    captions plus all their paragraphs. Each caption keeps its highest
    score, so a diet line like "macros: 275 cal | 30g protein" isn't
    drowned out by a long recipe."""
    texts = [clean(r) for r in raws]
    idx = [i for i, t in enumerate(texts) if t]

    diets = {}
    if diet_clf is not None and idx:
        pieces, owner = [], []
        for i in idx:
            for piece in [texts[i]] + paragraphs(raws[i]):
                pieces.append(piece)
                owner.append(i)
        for i, sc in zip(owner, diet_scores(pieces)):
            diets[i] = max(diets.get(i, 0.0), sc)

    results = []
    for i, t in enumerate(texts):
        diet = diets.get(i)
        if not t or diet is None:
            results.append({"blur": False, "score": 0.0, "diet_score": diet,
                            "reason": None, "mode": "empty" if not t else "no-model"})
            continue
        blur = diet >= DIET_THRESHOLD
        results.append({
            "blur": blur,
            "score": round(diet, 4),
            "diet_score": round(diet, 4),
            "reason": "diet" if blur else None,
            "mode": "diet",
        })
    return results


@app.route("/classify", methods=["POST"])
def classify():
    data = request.get_json(silent=True) or {}
    return jsonify(score_many([str(data.get("text", ""))])[0])


# Many captions at once (the extension uses this: much faster on busy pages)
MAX_BATCH = 32


@app.route("/classify_batch", methods=["POST"])
def classify_batch():
    data = request.get_json(silent=True) or {}
    raws = [str(t) for t in (data.get("texts") or [])][:MAX_BATCH]
    return jsonify({"results": score_many(raws)})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=True)
