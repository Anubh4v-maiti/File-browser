# JEE File Browser

Finding one document among the 77 files in the `jee` folder shouldn't mean
scrolling Explorer. This project gives that folder a search box, a shelf of
what you opened recently, and in-page previews.

It ships in **two editions** that share the same look and the same idea.

| | **Browser edition** (this folder) | **Local edition** (`local/`) |
| --- | --- | --- |
| Where it runs | Anywhere — hosted on Vercel | On this PC, offline |
| How files get in | You pick the folder in the page | It reads `Desktop\jee` by itself |
| Where files go | **Nowhere.** Read in the tab, never uploaded | Nowhere. Stays on disk |
| Search names + PDF text | Yes (pdf.js, in the browser) | Yes (`pypdf`, on the server) |
| "Recently opened" | Files you opened in the app | Your real Windows Recent items |
| Open in Acrobat / show in Explorer | No (a cloud page can't) | Yes |
| Preview | PDF viewer + images | PDF viewer + images |
| Needs Python | No | Yes |

The browser edition is the one to share or open on another device. The local
edition is the more powerful one on your own machine.

---

## Browser edition — deploy to Vercel

The whole app is three static files plus pdf.js. There is no backend, so
**nothing about your documents is ever uploaded** — the page reads the folder
through your browser, extracts the PDF text in a web worker, and keeps the
search index in your browser's own storage.

### Deploy

1. Push this repository to GitHub (it is set up to be private — see below).
2. On <https://vercel.com/new>, import the repository.
3. Leave every setting at its default:

   | Setting | Value |
   | --- | --- |
   | Framework Preset | **Other** |
   | Build Command | *(empty)* |
   | Output Directory | *(empty)* |
   | Install Command | *(empty)* |

4. Deploy. Vercel serves `index.html` from the root and you get a URL.

Nothing is built, so there is no build log to watch — the deploy finishes as
soon as the files are copied.

### Using it

1. Open the URL and click **Choose folder**.
2. Pick your `jee` folder. Chrome/Edge/Brave will ask for read permission once.
3. The folder is read and the PDF text is extracted — a progress bar shows
   `Reading PDF text n/N`. This is slow only the first time; the extracted text
   is cached in your browser, keyed to each file's size and modified date.

After the first visit the page offers **Reconnect to "jee"** — one click, then
the permission prompt, and you are back in with no re-reading.

### Keyboard

`/` search · `↑` `↓` move · `Enter` preview · `Esc` close

### Things worth knowing

* **Search covers names *and* document text.** A text hit is tagged with the
  page it came from and clicking it opens the PDF straight to that page.
* **Scanned PDFs have no text layer.** They stay searchable by file name only.
  Password-protected files are flagged as such — they are never a dead end.
* **"Recently opened" means opened *in this app*.** A web page cannot read
  Windows' Recent list. The app remembers what you opened (in `localStorage`),
  and until you have opened anything the shelf falls back to *Recently
  modified* — which is why you may see either title.
* **Browser support.** The folder picker needs Chrome, Edge or Brave. Firefox
  and Safari fall back to **Select files instead** (multi-select), which works
  for everything except remembering the folder.
* **File size limit.** Documents are read and previewed from your disk, so the
  73 MB merit-list PDF is fine — it never travels over the network.
* **Only the code is public.** No PDF or image is in this repository, and
  `.gitignore` refuses to add any.

---

## Local edition (`local/`)

Double-click **`Start Local App.bat`** in this folder (it hands over to
`local\Start JEE Browser.bat`).

A console window opens — **keep it running**, it *is* the server — and your
browser opens at <http://127.0.0.1:8777/>. Close the window or press Ctrl+C to
stop. If port 8777 is busy the server moves to 8778, 8779, … so use the address
printed in the window rather than a bookmark.

It reads `Desktop\jee` automatically and adds the two things a hosted page
cannot do:

* **Recently opened** — built from `%APPDATA%\Microsoft\Windows\Recent`, so it
  shows the files you actually used, newest first.
* **Open in app** and **Show in folder** — hand the file to Acrobat/Photos, or
  open Explorer with it selected.

Content search needs `pypdf` (`python -m pip install pypdf`); without it the
app still runs and matches file names only. Extracted text is cached in
`local/.cache/index.json`, so later starts are instant.

Full details, options and troubleshooting: [`local/README.md`](local/README.md).

---

## Layout

```
.
├─ index.html              browser edition — the whole UI
├─ app.js                  folder reading, pdf.js indexing, search, preview
├─ style.css               shared look and feel
├─ vendor/
│  ├─ pdf.min.mjs          pdf.js (Mozilla, Apache-2.0)
│  └─ pdf.worker.min.mjs   the worker that does the text extraction
├─ Start Local App.bat     launcher for the local edition
└─ local/
   ├─ server.py            stdlib-only server: indexing, Recent items, Range
   ├─ index.html           local edition UI
   ├─ app.js
   ├─ style.css
   ├─ Start JEE Browser.bat
   └─ README.md
```

## Credits

PDF text extraction uses [pdf.js](https://mozilla.github.io/pdf.js/) by
Mozilla, bundled under the Apache License 2.0. The local edition uses
[`pypdf`](https://pypdf.readthedocs.io/) if it is installed.
