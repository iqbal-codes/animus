#!/usr/bin/env python3
"""Loopback health, identity, pinned engine diagnostics and lap inspection."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from engine_diagnostics import EngineDiagnostics
from laps import (
    InvalidLapPayload,
    LapNotFound,
    LaunchBrakeError,
    NativeLaps,
    NativeLaunchError,
    NativeStateError,
    ReportNotFound,
)

DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Factory Operator Dashboard</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace, sans-serif; margin: 0; padding: 24px; background: #0f172a; color: #f8fafc; }
    h1, h2, h3 { margin-top: 0; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
    button { background: #2563eb; color: #fff; border: 1px solid #3b82f6; padding: 8px 16px; border-radius: 4px; font-weight: 600; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .status-banner { padding: 12px 16px; border-radius: 6px; margin-bottom: 20px; font-weight: 500; display: none; }
    .status-banner.visible { display: block; }
    .status-banner.error { background: #7f1d1d; color: #fecaca; border: 1px solid #b91c1c; }
    .status-banner.info { background: #1e293b; color: #94a3b8; border: 1px solid #334155; }
    .lap-table, .detail-table, .transitions-table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 14px; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #334155; }
    th { background: #1e293b; color: #94a3b8; text-transform: uppercase; font-size: 11px; letter-spacing: 0.05em; }
    tr.lap-row:hover { background: #1e293b; cursor: pointer; }
    tr.lap-row.selected { background: #1e3a8a; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
    .badge-running { background: #854d0e; color: #fef08a; }
    .badge-completed { background: #14532d; color: #bbf7d0; }
    .badge-failed { background: #7f1d1d; color: #fecaca; }
    .badge-cancelled { background: #374151; color: #d1d5db; }
    .badge-waiting_approval { background: #1e3a8a; color: #bfdbfe; }
    .detail-card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 20px; margin-top: 24px; }
    .detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 20px; }
    .field-label { font-size: 12px; color: #94a3b8; text-transform: uppercase; margin-bottom: 4px; }
    .field-value { font-family: monospace; font-size: 13px; word-break: break-all; }
    .agents-list, .transitions-container { margin-top: 16px; }
  </style>
</head>
<body>
  <div id="dashboard">
    <div class="toolbar">
      <h1>Factory Operator Dashboard</h1>
      <button id="refresh-button" type="button">Refresh</button>
    </div>

    <div id="status-message" class="status-banner" role="status"></div>

    <div id="laps-container">
      <table id="laps-table" class="lap-table" style="display: none;">
        <thead>
          <tr>
            <th>Run ID</th>
            <th>Workflow</th>
            <th>Native Status</th>
            <th>Product Status</th>
            <th>Timestamps</th>
            <th>Candidate Head</th>
            <th>Session Identity</th>
            <th>Work Item</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody id="laps-list"></tbody>
      </table>
    </div>

    <div id="lap-detail-container" class="detail-card" style="display: none;">
      <h2>Lap Details: <span id="detail-run-id"></span></h2>
      <div class="detail-grid">
        <div>
          <div class="field-label">Workflow</div>
          <div id="detail-workflow" class="field-value"></div>
        </div>
        <div>
          <div class="field-label">Native Status</div>
          <div id="detail-native-status" class="field-value"></div>
        </div>
        <div>
          <div class="field-label">Product Status</div>
          <div id="detail-product-status" class="field-value"></div>
        </div>
        <div>
          <div class="field-label">Candidate Head</div>
          <div id="detail-candidate-head" class="field-value"></div>
        </div>
        <div>
          <div class="field-label">Started At</div>
          <div id="detail-started-at" class="field-value"></div>
        </div>
        <div>
          <div class="field-label">Completed At</div>
          <div id="detail-completed-at" class="field-value"></div>
        </div>
        <div>
          <div class="field-label">Last Activity At</div>
          <div id="detail-last-activity-at" class="field-value"></div>
        </div>
        <div>
          <div class="field-label">Pull Request</div>
          <div id="detail-pull-request" class="field-value"></div>
        </div>
        <div style="grid-column: 1 / -1;">
          <div class="field-label">Work Item</div>
          <div id="detail-work-item" class="field-value"></div>
        </div>
      </div>

      <h3>Session Identity</h3>
      <div class="detail-grid">
        <div>
          <div class="field-label">Conversation ID</div>
          <div id="detail-conversation-id" class="field-value"></div>
        </div>
        <div>
          <div class="field-label">Working Path</div>
          <div id="detail-working-path" class="field-value"></div>
        </div>
        <div style="grid-column: 1 / -1;">
          <div class="field-label">Agents</div>
          <div id="detail-agents" class="field-value"></div>
        </div>
      </div>

      <div class="transitions-container">
        <h3>Observed Transitions</h3>
        <table class="transitions-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Step</th>
              <th>Event Type</th>
              <th>Event ID</th>
              <th>Timestamp</th>
            </tr>
          </thead>
          <tbody id="detail-transitions-list"></tbody>
        </table>
      </div>
    </div>
  </div>

  <script>
    (function() {
      let selectedRunId = null;

      const refreshBtn = document.getElementById('refresh-button');
      const statusMsg = document.getElementById('status-message');
      const lapsTable = document.getElementById('laps-table');
      const lapsList = document.getElementById('laps-list');
      const detailContainer = document.getElementById('lap-detail-container');

      function showStatus(text, type) {
        statusMsg.textContent = text;
        statusMsg.className = 'status-banner visible ' + type;
      }

      function clearStatus() {
        statusMsg.textContent = '';
        statusMsg.className = 'status-banner';
      }

      function clearView() {
        lapsList.textContent = '';
        lapsTable.style.display = 'none';
        detailContainer.style.display = 'none';
      }

      function safeText(val) {
        return (val !== null && val !== undefined) ? String(val) : '';
      }

      function setText(el, val) {
        if (typeof el === 'string') {
          el = document.getElementById(el);
        }
        if (el) {
          el.textContent = safeText(val);
        }
      }

      function createEl(tag, className, text) {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined && text !== null) el.textContent = safeText(text);
        return el;
      }

      async function fetchLaps() {
        try {
          const res = await fetch('/api/laps');
          if (!res.ok) {
            clearView();
            showStatus('Lap data unavailable', 'error');
            return;
          }
          const data = await res.json();
          if (!Array.isArray(data)) {
            clearView();
            showStatus('Lap data unavailable', 'error');
            return;
          }
          if (data.length === 0) {
            clearView();
            showStatus('No runs found', 'info');
            return;
          }

          clearStatus();
          renderLapsList(data);
          if (selectedRunId) {
            const stillExists = data.some(r => r.id === selectedRunId);
            if (stillExists) {
              fetchDetail(selectedRunId);
            } else {
              selectedRunId = null;
              detailContainer.style.display = 'none';
            }
          }
        } catch (err) {
          clearView();
          showStatus('Lap data unavailable', 'error');
        }
      }

      function renderLapsList(runs) {
        lapsList.textContent = '';
        lapsTable.style.display = 'table';

        runs.forEach(run => {
          const tr = createEl('tr', 'lap-row');
          tr.setAttribute('data-run-id', run.id || '');
          if (run.id === selectedRunId) {
            tr.classList.add('selected');
          }

          // ID
          const tdId = createEl('td', 'lap-id', run.id);
          tr.appendChild(tdId);

          // Workflow
          const tdWf = createEl('td', 'lap-workflow', run.workflow_name);
          tr.appendChild(tdWf);

          // Native Status
          const tdNative = createEl('td');
          const badgeNative = createEl('span', 'badge badge-' + (run.native_status || ''), run.native_status);
          badgeNative.classList.add('lap-native-status');
          tdNative.appendChild(badgeNative);
          tr.appendChild(tdNative);

          // Product Status
          const tdProd = createEl('td');
          const badgeProd = createEl('span', 'badge badge-' + (run.product_status || ''), run.product_status);
          badgeProd.classList.add('lap-product-status');
          tdProd.appendChild(badgeProd);
          tr.appendChild(tdProd);

          // Timestamps
          const tdTimes = createEl('td');
          const divStart = createEl('div', 'lap-started-at', 'Start: ' + safeText(run.started_at));
          const divComp = createEl('div', 'lap-completed-at', 'End: ' + safeText(run.completed_at));
          const divAct = createEl('div', 'lap-last-activity-at', 'Act: ' + safeText(run.last_activity_at));
          tdTimes.appendChild(divStart);
          tdTimes.appendChild(divComp);
          tdTimes.appendChild(divAct);
          tr.appendChild(tdTimes);

          // Candidate Head
          const tdCand = createEl('td', 'lap-candidate-head', run.candidate_head);
          tr.appendChild(tdCand);

          // Session Identity
          const tdSess = createEl('td');
          const sess = run.session || {};
          const divConv = createEl('div', 'lap-conversation-id', 'Conv: ' + safeText(sess.conversation_id));
          const divPath = createEl('div', 'lap-working-path', 'Path: ' + safeText(sess.working_path));
          tdSess.appendChild(divConv);
          tdSess.appendChild(divPath);
          if (Array.isArray(sess.agents) && sess.agents.length > 0) {
            const divAg = createEl('div', 'lap-agents', sess.agents.map(a => (a.node || '') + ':' + (a.session_id || '')).join(', '));
            tdSess.appendChild(divAg);
          }
          tr.appendChild(tdSess);

          // Work Item
          const tdWork = createEl('td', 'lap-work-item', run.work_item);
          tr.appendChild(tdWork);

          // Action
          const tdAct = createEl('td');
          const selBtn = createEl('button', 'select-lap-btn', 'Select');
          selBtn.type = 'button';
          selBtn.setAttribute('data-run-id', run.id || '');
          selBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            selectRun(run.id);
          });
          tdAct.appendChild(selBtn);
          tr.appendChild(tdAct);

          tr.addEventListener('click', () => {
            selectRun(run.id);
          });

          lapsList.appendChild(tr);
        });
      }

      async function selectRun(runId) {
        selectedRunId = runId;
        const rows = lapsList.querySelectorAll('.lap-row');
        rows.forEach(r => {
          if (r.getAttribute('data-run-id') === runId) {
            r.classList.add('selected');
          } else {
            r.classList.remove('selected');
          }
        });
        await fetchDetail(runId);
      }

      async function fetchDetail(runId) {
        try {
          const res = await fetch('/api/laps/' + encodeURIComponent(runId));
          if (!res.ok) {
            clearView();
            showStatus('Lap data unavailable', 'error');
            return;
          }
          const detail = await res.json();
          renderDetail(detail);
        } catch (err) {
          clearView();
          showStatus('Lap data unavailable', 'error');
        }
      }

      function renderDetail(detail) {
        setText('detail-run-id', detail.id);
        setText('detail-workflow', detail.workflow_name);
        setText('detail-native-status', detail.native_status);
        setText('detail-product-status', detail.product_status);
        setText('detail-candidate-head', detail.candidate_head);
        setText('detail-started-at', detail.started_at);
        setText('detail-completed-at', detail.completed_at);
        setText('detail-last-activity-at', detail.last_activity_at);
        setText('detail-pull-request', detail.pull_request);
        setText('detail-work-item', detail.work_item);

        const sess = detail.session || {};
        setText('detail-conversation-id', sess.conversation_id);
        setText('detail-working-path', sess.working_path);

        const agentsContainer = document.getElementById('detail-agents');
        agentsContainer.textContent = '';
        if (Array.isArray(sess.agents) && sess.agents.length > 0) {
          sess.agents.forEach(agent => {
            const div = createEl('div', 'agent-item', (agent.node || '') + ': ' + (agent.session_id || ''));
            agentsContainer.appendChild(div);
          });
        } else {
          agentsContainer.textContent = 'None';
        }

        const transList = document.getElementById('detail-transitions-list');
        transList.textContent = '';
        const transitions = detail.transitions || [];
        transitions.forEach(t => {
          const tr = createEl('tr', 'transition-row');
          tr.appendChild(createEl('td', 't-order', t.event_order));
          tr.appendChild(createEl('td', 't-step', t.step_name));
          tr.appendChild(createEl('td', 't-type', t.event_type));
          tr.appendChild(createEl('td', 't-id', t.id));
          tr.appendChild(createEl('td', 't-time', t.created_at));
          transList.appendChild(tr);
        });

        detailContainer.style.display = 'block';
      }

      refreshBtn.addEventListener('click', () => {
        fetchLaps();
      });

      fetchLaps();
    })();
  </script>
</body>
</html>
"""


def handler(build_id: str, laps: NativeLaps) -> type[BaseHTTPRequestHandler]:
    diagnostics = EngineDiagnostics(laps.root)

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:
            path = urlsplit(self.path).path
            if path == "/api/doctor":
                status, result = diagnostics.inspect(doctor=True)
                self.respond(status, json.dumps(result).encode("utf-8"), "application/json")
            elif path == "/api/laps":
                try:
                    content_length = int(self.headers.get("Content-Length", "0"))
                    if content_length < 0:
                        content_length = 0
                except (ValueError, TypeError):
                    content_length = 0
                body = self.rfile.read(content_length) if content_length > 0 else b""
                if len(body) != content_length:
                    self.respond(400, json.dumps({"error": "invalid_payload"}).encode("utf-8"), "application/json")
                    return
                try:
                    result = laps.submit(body)
                    status = 202
                except InvalidLapPayload:
                    status, result = 400, {"error": "invalid_payload"}
                except LaunchBrakeError:
                    status, result = 409, {"error": "launch_brake_set"}
                except NativeLaunchError:
                    status, result = 502, {"error": "launch_process_failed"}
                except NativeStateError:
                    status, result = 503, {"error": "native_state_unavailable"}
                self.respond(status, json.dumps(result).encode("utf-8"), "application/json")
            else:
                self.send_error(404)

        def do_GET(self) -> None:
            path = urlsplit(self.path).path
            status = 200
            if path in ("/", ""):
                body = DASHBOARD_HTML.encode("utf-8")
                content_type = "text/html; charset=utf-8"
            elif path == "/health":
                body = json.dumps({"status": "healthy"}).encode("utf-8")
                content_type = "application/json"
            elif path == "/build-id":
                body = build_id.encode("utf-8")
                content_type = "text/plain; charset=utf-8"
            elif path == "/api/workflows":
                status, result = diagnostics.inspect()
                body = json.dumps(result).encode("utf-8")
                content_type = "application/json"
            elif path == "/api/laps" or path.startswith("/api/laps/"):
                subpath = path[len("/api/laps"):]
                if not subpath:
                    try:
                        result = laps.read(None)
                    except LapNotFound:
                        status, result = 404, {"error": "lap_not_found"}
                    except NativeStateError:
                        status, result = 503, {"error": "native_state_unavailable"}
                    body = json.dumps(result).encode("utf-8")
                    content_type = "application/json"
                elif subpath.startswith("/"):
                    rest = subpath[1:]
                    if rest.endswith("/evidence/report"):
                        run_id = rest[:-len("/evidence/report")]
                        try:
                            content, content_type = laps.read_report(run_id)
                            body = content.encode("utf-8")
                        except LapNotFound:
                            status, result = 404, {"error": "lap_not_found"}
                            body = json.dumps(result).encode("utf-8")
                            content_type = "application/json"
                        except ReportNotFound:
                            status, result = 404, {"error": "report_not_found"}
                            body = json.dumps(result).encode("utf-8")
                            content_type = "application/json"
                        except NativeStateError:
                            status, result = 503, {"error": "native_state_unavailable"}
                            body = json.dumps(result).encode("utf-8")
                            content_type = "application/json"
                    elif rest.endswith("/evidence"):
                        run_id = rest[:-len("/evidence")]
                        try:
                            result = laps.read_evidence(run_id)
                        except LapNotFound:
                            status, result = 404, {"error": "lap_not_found"}
                        except NativeStateError:
                            status, result = 503, {"error": "native_state_unavailable"}
                        body = json.dumps(result).encode("utf-8")
                        content_type = "application/json"
                    else:
                        run_id = rest
                        try:
                            result = laps.read(run_id)
                        except LapNotFound:
                            status, result = 404, {"error": "lap_not_found"}
                        except NativeStateError:
                            status, result = 503, {"error": "native_state_unavailable"}
                        body = json.dumps(result).encode("utf-8")
                        content_type = "application/json"
                else:
                    self.send_error(404)
                    return
            else:
                self.send_error(404)
                return
            self.respond(status, body, content_type)

        def respond(self, status: int, body: bytes, content_type: str) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format: str, *args: object) -> None:
            # Request targets can contain secrets; do not emit access logs.
            return

    return Handler


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()

    build_id = os.environ.get("FACTORY_RUNTIME_CANDIDATE")
    if build_id is None:
        build_id = subprocess.check_output(
            ["git", "rev-parse", "HEAD"],
            cwd=Path(__file__).resolve().parent,
            text=True,
        ).strip()

    def stop(signum: int, frame: object) -> None:
        raise SystemExit(0)

    laps = NativeLaps(Path(__file__).resolve().parent)
    with ThreadingHTTPServer(("127.0.0.1", args.port), handler(build_id, laps)) as server:
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        server.serve_forever()


if __name__ == "__main__":
    main()
