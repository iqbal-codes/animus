#!/usr/bin/env python3
"""Run real service and capture live headless Playwright screenshots for verification."""
import os
import signal
import socket
import subprocess
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "artifacts" / "screenshots"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Find free port
with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]

# Start server
env = os.environ.copy()
env["FACTORY_RUNTIME_CANDIDATE"] = "candidate-live-verify"
proc = subprocess.Popen(
    ["python3", "app.py", "--port", str(port)],
    cwd=ROOT,
    env=env,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
)

try:
    time.sleep(1.0)
    url = f"http://127.0.0.1:{port}/"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)

        # 1. Desktop Viewport (1440x900)
        page = browser.new_page(viewport={"width": 1440, "height": 900}, color_scheme="dark")
        page.goto(url, wait_until="domcontentloaded")
        time.sleep(1.0)

        desktop_path = OUT_DIR / "desktop_console.png"
        page.screenshot(path=str(desktop_path), full_page=False)
        print(f"Captured desktop screenshot: {desktop_path}")

        # 2. Promotion Modal Open (Click "Promote 4 commits to main")
        promote_btn = page.query_selector("#promote-main-btn")
        if promote_btn:
            promote_btn.click()
            time.sleep(0.5)
            modal_path = OUT_DIR / "promotion_modal.png"
            page.screenshot(path=str(modal_path), full_page=False)
            print(f"Captured promotion modal screenshot: {modal_path}")

            # Close modal
            close_btn = page.query_selector("#close-promotion-modal")
            if close_btn:
                close_btn.click()
                time.sleep(0.3)

        # 3. Mobile Viewport (375x812)
        mobile_page = browser.new_page(viewport={"width": 375, "height": 812}, color_scheme="dark")
        mobile_page.goto(url, wait_until="domcontentloaded")
        time.sleep(1.0)
        mobile_path = OUT_DIR / "mobile_console.png"
        mobile_page.screenshot(path=str(mobile_path), full_page=False)
        print(f"Captured mobile screenshot: {mobile_path}")

        browser.close()

finally:
    proc.send_signal(signal.SIGTERM)
    proc.communicate(timeout=2)
