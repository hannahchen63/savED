# savED: setup

*This project is a prototype and is not medical advice.*

savED has two parts that run together on your computer:
- **The server** (Python, in `server/`) runs the diet model.
- **The extension** (in `extension/`) runs in Chrome, reads each post's caption, asks the server, and covers posts that may be triggering.

You need **Google Chrome** and **Python 3** ([python.org/downloads](https://www.python.org/downloads/)).

## 1. Start the server

Open a terminal in the `Main Extension/server` folder, then run:

```
python3 -m pip install -r requirements.txt
python3 app.py
```

The install step is only needed the first time and takes a few minutes. When the server is ready, you'll see:

```
[diet model] READY
...
savED is running. Leave this window open while you browse.
```

Leave this window open. To check it, open http://localhost:5001/health in Chrome. It should show `"diet_model": "loaded"`.

> On Windows, use `python` instead of `python3`.

## 2. Load the extension in Chrome

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and choose the `Main Extension/extension` folder
4. Click the puzzle piece in Chrome's toolbar and **pin savED**

## 3. Use it

Open Instagram, YouTube, or TikTok. Posts about dieting, calorie counting, or weight loss are covered as you scroll.

- **Show anyway** uncovers a post.
- Click the **savED icon** for the on/off switch.
- To see what savED decided for each post: press **F12**, open **Console**, and type `savED` in the filter box.

## Troubleshooting

| Problem | Fix |
|---|---|
| Nothing is covered | Is the server window still open and showing "savED is running"? Is the switch in the savED popup on? |
| `[diet model] FAILED` when starting | Run the install step again: `python3 -m pip install -r requirements.txt` |
| `Address already in use` | Another program is using port 5001. Restart the computer, or close other servers. |
| Changed a file | Click the reload arrow on savED at `chrome://extensions`, then refresh the page. |

## Files

```
extension/
  manifest.json   tells Chrome what savED is and where it runs
  content.js      finds posts, reads captions, covers flagged posts
  background.js   sends captions to the server
  popup.html/js   the on/off switch
  styles.css      how covers look
  icons/          the savED logo
server/
  app.py          cleans each caption, runs the diet model, returns blur or not
  diet_model/     the trained diet model (embedder + classifier)
  requirements.txt
```
