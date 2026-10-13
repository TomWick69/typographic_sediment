"""Inline src/ and vendor/ into a single self-contained dist/index.html.

Run: python3 build.py
"""
import base64
from pathlib import Path

root = Path(__file__).parent
read = lambda p: (root / p).read_text(encoding='utf-8')
html = read('src/index.html')

# embed the font files so the page needs nothing from the network
fonts = read('vendor/fonts.css')
for woff in (root / 'vendor' / 'fonts').glob('*.woff2'):
    data = base64.b64encode(woff.read_bytes()).decode()
    fonts = fonts.replace(f'url(fonts/{woff.name})', f'url(data:font/woff2;base64,{data})')
assert 'url(fonts/' not in fonts, 'a font file named in vendor/fonts.css is missing'
html = html.replace('/*FONTS*/', fonts.rstrip('\n'))

for mark, path in [('/*STYLE*/', 'src/styles.css'), ('/*MATTER*/', 'vendor/matter.min.js'),
                   ('/*ENGINE*/', 'src/engine.js'), ('/*APP*/', 'src/app.js'),
                   ('/*GLASS*/', 'src/glass.js'), ('/*INTRO*/', 'src/intro.js')]:
    assert html.count(mark) == 1, mark
    html = html.replace(mark, read(path).rstrip('\n'))
out = root / 'dist' / 'index.html'
out.parent.mkdir(exist_ok=True)
out.write_text(html, encoding='utf-8')
print(f'{out.relative_to(root)}  {len(html.encode()) / 1024:.0f} KB')
