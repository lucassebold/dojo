"""Downloads the pictures used by the made-up launches on the Pulse page and stores them in public/img/tk/ (128 px).

Run once (needs Pillow):  python tools/fetch_token_images.py
Only sources whose licence allows this use are taken, and nobody's face or brand is picked on purpose:
  - cat-*.jpg    The Cat API (https://thecatapi.com), cat photos uploaded by its community
  - photo-*.jpg  Lorem Picsum (https://picsum.photos), photos under the Unsplash licence
  - av-*.svg     DiceBear (https://dicebear.com), styles thumbs / pixel-art / lorelei, all CC0 1.0
"""
import io, json, os, random, sys, time, urllib.request

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'img', 'tk')
os.makedirs(OUT, exist_ok=True)
UA = {'User-Agent': 'dojo-practice-market/1.0 (image pool for simulated launches)'}
rng = random.Random(7)


def get(url, timeout=30):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=timeout).read()


def square_jpeg(raw, path, size=128):
    from PIL import Image
    im = Image.open(io.BytesIO(raw)).convert('RGB')
    w, h = im.size
    if min(w, h) < 120:
        return False
    s = min(w, h)
    im = im.crop(((w - s) // 2, (h - s) // 2, (w - s) // 2 + s, (h - s) // 2 + s)).resize((size, size), Image.LANCZOS)
    im.save(path, 'JPEG', quality=74, optimize=True)
    return True


def cats(n):
    seen, got = set(), 0
    for _ in range(40):
        if got >= n:
            break
        try:
            for it in json.loads(get('https://api.thecatapi.com/v1/images/search?limit=10&mime_types=jpg,png')):
                if it['id'] in seen or got >= n:
                    continue
                seen.add(it['id'])
                if square_jpeg(get(it['url']), os.path.join(OUT, 'cat-%03d.jpg' % (got + 1))):
                    got += 1
        except Exception as e:
            print('  cat batch failed:', e)
        time.sleep(0.4)
    return got


def photos(n):
    ids = list(range(0, 1085)); rng.shuffle(ids)
    got = 0
    for i in ids:
        if got >= n:
            break
        try:
            if square_jpeg(get('https://picsum.photos/id/%d/256/256' % i), os.path.join(OUT, 'photo-%03d.jpg' % (got + 1))):
                got += 1
        except Exception:
            pass                       # some ids do not exist
        time.sleep(0.15)
    return got


def avatars(per_style):
    got = 0
    for style in ('thumbs', 'pixel-art', 'lorelei'):
        for k in range(per_style):
            seed = '%s-%d' % (style, rng.randrange(10 ** 6))
            url = 'https://api.dicebear.com/9.x/%s/svg?seed=%s&size=128&backgroundColor=b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf' % (style, seed)
            try:
                svg = get(url)
                if b'<svg' in svg:
                    got += 1
                    open(os.path.join(OUT, 'av-%03d.svg' % got), 'wb').write(svg)
            except Exception as e:
                print('  avatar failed:', e)
            time.sleep(0.15)
    return got


if __name__ == '__main__':
    print('cats   :', cats(60))
    print('photos :', photos(80))
    print('avatars:', avatars(28))
    with open(os.path.join(OUT, 'CREDITS.md'), 'w', encoding='utf-8') as f:
        f.write('# Picture credits\n\nUsed only as avatars of made-up launches in a practice market.\n\n'
                '- `cat-*.jpg`: cat photos from [The Cat API](https://thecatapi.com), uploaded by its community.\n'
                '- `photo-*.jpg`: photos from [Lorem Picsum](https://picsum.photos) under the [Unsplash licence](https://unsplash.com/license).\n'
                '- `av-*.svg`: [DiceBear](https://dicebear.com) avatars, styles *thumbs*, *pixel-art* and *lorelei*, all [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).\n\n'
                'Regenerate with `python tools/fetch_token_images.py`.\n')
    total = sum(os.path.getsize(os.path.join(OUT, x)) for x in os.listdir(OUT))
    print('files:', len(os.listdir(OUT)), '| total %.0f KB' % (total / 1024))
