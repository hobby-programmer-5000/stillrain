#!/usr/bin/env python3
"""build.py - put the whole film into one file. Standard library only.

    python tools/build.py                        -> dist/stillrain.html, a copy at ./index.html, and dist/SIZES.txt
    python tools/build.py --check                syntax-check every source file with `node --check` first (needs Node on PATH)
    python tools/build.py --out build/x.html     write only that file (no index.html copy, no SIZES.txt): for test builds
    python tools/build.py --skip film/world.js   leave files out, comma separated (without world.js, film/stub.js draws a
                                                 plain valley)

three.js (vendor/three.module.min.js, r170, MIT) is turned from an ES module into a plain global `THREE`, then every source
file goes into the page in the order below, one <script> tag each, so a mistake in one scene cannot take the others down
(the same rule as bide's tools/build.py; ChetasLua/bide, MIT). Nothing is fetched at run time: the page makes no network request.
The order matters: a file may read the files before it while it loads (score, then valley, path, events), the modules build
later in main.js's boot, and main.js comes last because it starts the film. The page around the scripts is
film/index.src.html, with the markers <!--THREE--> and <!--FILM--> where the scripts go. The build prints the size of every part.
"""
import argparse, glob, os, re, shutil, subprocess, sys, zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # the project folder (this file is in tools/)
P = lambda *a: os.path.join(ROOT, *a)                                # a path inside the project
NAME = "stillrain"


def read(path):
    """A text file as a string (UTF-8)."""
    with open(path, encoding="utf-8") as f:
        return f.read()


def safe(js):
    """Nothing inside a script may close it or open a comment state."""
    js = re.sub(r"</(script)", r"<\\/\1", js, flags=re.I)
    return js.replace("<!--", "<\\!--")


def three_global():
    """three.module.min.js as a classic script: `var THREE=(function(){...; return {Name:local, ...};})();`.

    The minified module ends with one `export{a as B, ...}` list. Cut it off, wrap the rest in a function, and return the
    exported names as an object, so every source file can use the global THREE (three.js addons are not used).
    """
    mod = read(P("vendor", "three.module.min.js")).strip()
    m = re.search(r"export\s*\{([^}]*)\}\s*;?\s*$", mod)
    if not m:
        sys.exit("could not find the export list at the end of three.module.min.js")
    body, pairs = mod[: m.start()], []
    for item in m.group(1).split(","):
        item = item.strip()
        if item:
            local, name = [x.strip() for x in item.split(" as ")] if " as " in item else (item, item)
            pairs.append(f"{name}:{local}")
    return "var THREE=(function(){'use strict';" + body + ";return{" + ",".join(pairs) + "};})();"


def kb(n):
    """A byte count for the size report: KB below 1 MB, else MB."""
    return f"{n/1024:,.1f} KB" if n < 1 << 20 else f"{n/1048576:,.2f} MB"


def main():
    """Collect the sources, check them, write the page and print the size report."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--out", default=None, help="write here instead of dist/ (no index.html copy, no SIZES.txt)")
    ap.add_argument("--skip", default="", help="comma list of source files to leave out, e.g. film/cast.js,film/scenes/s05.js")
    a = ap.parse_args()

    # the load order: kits and shared tables first (anim, engine, sculpt, score, valley, path, events), then the modules
    # (stub, world, life, rain, cast, crowd), the camera kit and the shots, the sound, the titles, and main.js last
    files = ["film/anim.js", "film/engine.js", "film/sculpt.js", "music/score.js", "film/valley.js", "film/path.js", "film/events.js",
             "film/stub.js", "film/world.js", "film/life.js", "film/rain.js", "film/cast.js", "film/crowd.js", "film/camera.js"]
    files += sorted(os.path.relpath(f, ROOT).replace(os.sep, "/") for f in glob.glob(P("film", "scenes", "s*.js")))
    files += ["music/synth.js", "film/titles.js", "film/main.js"]
    skip = {x.strip() for x in a.skip.split(",") if x.strip()}
    files = [f for f in files if f not in skip]
    main_out = a.out is None   # the real build (dist/ + index.html + SIZES.txt) rather than a test build
    a.out = a.out or P("dist", NAME + ".html")
    node = shutil.which("node") if a.check else None   # --check without Node on PATH builds without the check
    tags, rows, missing, bad = [], [], [], []
    for rel in files:
        path = P(*rel.split("/"))
        if not os.path.exists(path):
            missing.append(rel)
            continue
        if node:
            r = subprocess.run([node, "--check", path], capture_output=True, text=True)
            if r.returncode:
                bad.append(f"{rel}\n{r.stderr.strip()[:1200]}")
        src = safe(read(path))
        # each file in its own <script>, labelled with its path so errors in the console point at the source
        rows.append((rel, len(src.encode())))
        tags.append(f"<script>/* {rel} */\n{src}\n</script>")
    if bad:
        sys.exit("SYNTAX ERROR\n" + "\n\n".join(bad))
    for m in missing:
        print("warning: missing, skipped:", m, file=sys.stderr)

    three = three_global()
    html = read(P("film", "index.src.html"))
    html = html.replace("<!--THREE-->", "<script>/* three.js r170, MIT, vendor/LICENSE */\n" + safe(three) + "\n</script>")
    html = html.replace("<!--FILM-->", "\n".join(tags))
    # the film must not load anything from the network: warn about any src= or href= that points to another host
    for ref in re.findall(r"""(?:src|href)\s*=\s*["'](?:https?:)?//[^"']+""", html):
        print("warning: external reference in page:", ref, file=sys.stderr)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    data = html.encode()
    tmp = a.out + ".part"   # write to a side file, then swap it in, so a page being viewed is never half written
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, a.out)
    if main_out:
        shutil.copyfile(a.out, P("index.html"))

    code = sum(n for _, n in rows)
    lines = [f"{os.path.relpath(a.out, ROOT)}  {kb(len(data))}",
             f"  three.js r170 {kb(len(three.encode())):>12}",
             f"  film code     {kb(code):>12}  ({kb(len(zlib.compress(chr(10).join(tags).encode(), 9)))} compressed)"]
    lines += [f"    {kb(n):>12}  {rel}" for rel, n in rows]
    if missing:
        lines.append("  missing: " + ", ".join(missing))
    text = "\n".join(lines) + "\n"
    if main_out:
        with open(P("dist", "SIZES.txt"), "w", encoding="utf-8") as f:
            f.write(text)
    print(text, end="")


if __name__ == "__main__":
    main()
