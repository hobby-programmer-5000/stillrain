#!/usr/bin/env python3
"""Record STILLRAIN into a video file. Standard library only, plus ffmpeg on PATH.

    python tools/build.py                  (makes dist/stillrain.html)
    python tools/record.py [port]          (default 8792)
    then open  http://127.0.0.1:<port>/dist/stillrain.html?rec=1920x1080&fps=30
    (&from=SECONDS&dur=SECONDS record a part only)

The page renders every frame at a fixed time step (so nothing is dropped, however slow the machine) and POSTs it here as
raw RGBA; this server pipes the frames straight into ffmpeg. Then the page renders the score offline and POSTs a WAV,
and the two are muxed into out/stillrain.mp4. Progress shows in the page title. Needs ffmpeg on PATH.

The protocol (film/main.js record()):
    POST /begin?w=&h=&fps=   start ffmpeg (H.264) writing out/video.mp4
    POST /frame              one frame: exactly w * h * 4 bytes of RGBA, titles already drawn on it
    POST /audio              the score as a 16-bit WAV, saved as out/audio.wav
    POST /end                close the video, then mux video + audio (AAC 192k) into out/stillrain.mp4
It also serves the project folder over plain GET, so the page and the server share one origin (the page's POSTs need that).
It listens on 127.0.0.1 only.
"""
import http.server, os, subprocess, sys, urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "out")
state = {}   # the recording in progress: size, fps, frame count and the ffmpeg process


class H(http.server.SimpleHTTPRequestHandler):
    """Serves the project folder (GET) and takes the recording (POST)."""

    def __init__(self, *a, **k):
        super().__init__(*a, directory=ROOT, **k)

    def log_message(self, fmt, *args):
        """Log every request except the thousands of frames."""
        if "/frame" not in self.path:
            sys.stderr.write("%s\n" % (fmt % args))

    def body(self):
        """The request body, read in full (a 1080p frame is about 8 MB and arrives in pieces)."""
        n = int(self.headers.get("Content-Length", 0))
        buf = bytearray(n)
        view, got = memoryview(buf), 0
        while got < n:
            r = self.rfile.readinto(view[got:])
            if not r:
                break
            got += r
        return bytes(buf[:got])

    def ok(self, msg=b"ok"):
        """Answer 200 with a short body."""
        self.send_response(200)
        self.send_header("Content-Length", str(len(msg)))
        self.end_headers()
        self.wfile.write(msg)

    def do_POST(self):
        """One branch per step of the protocol in the module docstring."""
        u = urllib.parse.urlparse(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        if u.path == "/begin":
            os.makedirs(OUT, exist_ok=True)
            w, h, fps = int(q["w"]), int(q["h"]), int(q.get("fps", 30))
            state.update(w=w, h=h, fps=fps, n=0)
            # crf 22 + slow: about 85 MB for the whole film at 1080p30 (the grain costs bits; crf 18 was ~240 MB)
            state["ff"] = subprocess.Popen(
                ["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
                 "-c:v", "libx264", "-preset", "slow", "-crf", "22", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
                 os.path.join(OUT, "video.mp4")], stdin=subprocess.PIPE)
            return self.ok()
        if u.path == "/frame":
            data = self.body()
            if len(data) != state["w"] * state["h"] * 4:
                self.send_error(400, "frame size")
                return
            state["ff"].stdin.write(data)
            state["n"] += 1
            return self.ok()
        if u.path == "/audio":
            with open(os.path.join(OUT, "audio.wav"), "wb") as f:
                f.write(self.body())
            return self.ok()
        if u.path == "/end":
            ff = state["ff"]
            ff.stdin.close()
            ff.wait()
            final = os.path.join(OUT, "stillrain.mp4")
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", os.path.join(OUT, "video.mp4"), "-i", os.path.join(OUT, "audio.wav"),
                            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", final], check=True)
            sys.stderr.write(f"wrote {final} ({state['n']} frames)\n")
            return self.ok()
        self.send_error(404)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8792
    http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
