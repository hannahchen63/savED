# Gentle Feed: setup

This project is a prototype and is not medical advice.

## 1. Start the server (Terminal)

```
cd server
pip install flask flask-cors
python app.py
```

You should see "Using keyword PLACEHOLDER." Leave this window open.
Check it works: open http://localhost:5000/health in Chrome.

## 2. Load the extension (Chrome)

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick the `extension` folder
4. Open instagram.com and scroll
5. Press F12 > Console to see `[Gentle Feed]` scores for each post

After editing any extension file, click the reload arrow on the extension card,
then refresh Instagram.

## 3. Switch to the real model (when it arrives)

1. Unzip `ed_model.zip` into `server/ed_model/`
   (that folder should directly contain `config.json`, the model weights, and tokenizer files)
2. `pip install torch transformers`
3. Restart `python app.py`. It should print "Loaded model" and the labels.
   Confirm with your teammate that label 1 means harmful.

## Testing without Instagram

```
curl -X POST http://localhost:5001/classify -H "Content-Type: application/json" -d "{\"text\": \"high protein breakfast, 300 calories\"}"
```

## Files

- `extension/manifest.json`: tells Chrome what the extension is and where it runs
- `extension/content.js`: finds posts, reads captions, blurs them
- `extension/background.js`: sends captions to the server
- `extension/styles.css`: the blur and overlay look
- `server/app.py`: cleans the caption, scores it, returns blur yes/no
