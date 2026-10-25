"""SoundRazer Desktop - Native app using pywebview."""
import sys
import os
import threading
import time
import webbrowser
from pathlib import Path

try:
    import webview
    from webview.window import FixPoint
except ImportError:
    webview = None
    FixPoint = None

# Use the CLI to start the UI server
from sound_razor import ui

MIN_WIDTH, MIN_HEIGHT = 1100, 700

# Which corner/edge stays put while the opposite one follows the mouse, keyed by the
# resize handle's compass direction (see resize_to below).
FIX_POINTS = None if FixPoint is None else {
    "n": FixPoint.SOUTH | FixPoint.WEST, "s": FixPoint.NORTH | FixPoint.WEST,
    "e": FixPoint.NORTH | FixPoint.WEST, "w": FixPoint.NORTH | FixPoint.EAST,
    "ne": FixPoint.SOUTH | FixPoint.WEST, "nw": FixPoint.SOUTH | FixPoint.EAST,
    "se": FixPoint.NORTH | FixPoint.WEST, "sw": FixPoint.NORTH | FixPoint.EAST,
}


class WindowControls:
    """Window controls for the custom title bar and its invisible resize edges.

    Reached over the app's own HTTP API (POST/GET /api/window/<action>), not pywebview's
    JS bridge: in practice window.pywebview never materializes in the page here, so the
    bridge is unusable. Calling pywebview's window methods from this (non-GUI) server
    thread is the officially supported cross-thread usage pattern.

    Move and resize are driven by continuous mousemove from the page (see app.js), not
    the classic WM_SYSCOMMAND/HTCAPTION "let the OS drag it" trick: that trick is well
    known to be unreliable with Chromium-based webviews (WebView2's own mouse capture
    competes with the OS's), and that's exactly what we saw here — it simply never moved
    the window. Explicit move()/resize() calls on every frame sidestep that entirely.
    """

    def __init__(self):
        self._window = None

    def attach(self, window):
        self._window = window

    def minimize(self):
        self._window.minimize()

    def is_maximized(self):
        # Ask the real native window rather than tracking our own flag: two toggle
        # calls close together (a fast double-click, or two browser tabs) would
        # otherwise race and leave a hand-rolled flag out of sync with reality.
        if self._window is None or self._window.native is None:
            return False
        return str(self._window.native.WindowState) == "Maximized"

    def toggle_maximize(self):
        self._window.restore() if self.is_maximized() else self._window.maximize()
        return self.is_maximized()

    def close(self):
        self._window.destroy()

    def bounds(self):
        w = self._window
        return {"x": w.x, "y": w.y, "width": w.width, "height": w.height}

    def move_to(self, x, y):
        try:
            self._window.move(int(x), int(y))
        except (TypeError, ValueError):
            raise ValueError("move needs numeric x/y.") from None

    def resize_to(self, width, height, direction):
        try:
            width, height = int(width), int(height)
        except (TypeError, ValueError):
            raise ValueError("resize needs numeric width/height.") from None
        fix = FIX_POINTS.get(direction, FixPoint.NORTH | FixPoint.WEST)
        self._window.resize(max(MIN_WIDTH, width), max(MIN_HEIGHT, height), fix)


def main():
    host = "127.0.0.1"
    port = 8765

    # Use the CLI to start the UI server
    from sound_razor.ui import serve
    from pathlib import Path

    # Created before the window exists and handed straight to serve(): it's only ever
    # *used* once a request reaches it, which can't happen until the window (created
    # further down) is visible and attach() below has already run.
    controls = WindowControls() if webview is not None else None

    def run_server():
        serve(None, port, Path(".sound-razor/models"), window=controls)

    server_thread = threading.Thread(target=run_server, daemon=True)
    server_thread.start()

    # Give server time to start
    time.sleep(2)

    url = f"http://{host}:{port}"

    if webview is not None:
        # ?native=1 tells the page (synchronously, no race) to show its own title bar
        # immediately; its buttons call back through controls above via the HTTP API.
        window = webview.create_window(
            title="SoundRazer Desktop",
            url=f"{url}/?native=1",
            width=1400,
            height=900,
            min_size=(MIN_WIDTH, MIN_HEIGHT),
            resizable=True,
            frameless=True,
            background_color="#0b0c0f",
        )
        controls.attach(window)
        # Lets Chrome DevTools attach to the real window for troubleshooting (distinct
        # from debug=True below, which would also add a right-click "Inspect" menu).
        webview.settings["REMOTE_DEBUGGING_PORT"] = 9223
        webview.start(debug=False)
    else:
        webbrowser.open(url)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
