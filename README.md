# Typographic Sediment

Pictures made of letters that fall, collide and settle.

Give it an image and a line of text. It drops the letters in one at a time, with a little physics, and keeps each one only if it brings the picture closer to your image. A few thousand letters later, the image shows up. No AI and no server: everything runs in your browser, the page makes no network requests, and your image never leaves it.

## Features

- Scroll-through book preface that zooms into the studio
- Five letter typefaces, six backgrounds (including transparent), three colour modes
- Canvas sizes from 480 px up to 4K, up to 50,000 letters
- Time-lapse replay, and export as PNG, SVG or video
- Light and dark themes, with a liquid-glass switch

## Run it

Open `dist/index.html` in a browser. That's the whole site in one file.

## Develop

The source lives in `src/`; `build.py` inlines it, with the bundled physics library, into `dist/index.html`.

```sh
python3 build.py        # rebuild dist/index.html
npm install             # only needed for the screenshot tests
node tools/shot.mjs intro /tmp/shots   # scenarios: intro, studio, clear, flows, mobile, toggle, big, upload
node tools/offline-check.mjs           # confirms the page makes no network requests
```

The test scripts expect Chromium at `/usr/bin/chromium`.

## Credits

- Physics: [matter-js](https://brm.io/matter-js/) 0.20.0 by Liam Brummitt, MIT licence (bundled in `vendor/`)
- Type: [Figtree](https://github.com/erikdkennedy/figtree) by Erik Kennedy, SIL Open Font Licence 1.1 (embedded in the page; files and licence in `vendor/fonts/`)
