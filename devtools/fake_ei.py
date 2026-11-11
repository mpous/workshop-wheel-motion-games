"""Minimal stand-in for the Edge Impulse Studio + ingestion APIs used by
ardu-kart/python/controller.py, so the Motion Lab can be tested offline.

    srv = FakeEI(api_key="ei_" + "a" * 32).start()
    env["ARDUKART_EI_STUDIO_URL"] = srv.url + "/v1/api"
    env["ARDUKART_EI_INGEST_URL"] = srv.url

`srv.uploads` keeps every ingested sample, `srv.requests` every request line.
Run it alone (python3 devtools/fake_ei.py) to point a local server at it.
"""
import io
import json
import re
import threading
import zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PID = 4242
LIB = "ardukart-wheel_inferencing"


def library_zip():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(f"{LIB}/library.properties", "name=Ardu Kart wheel\nversion=1.0.3\n")
        z.writestr(f"{LIB}/src/{LIB}.h", "// fake Edge Impulse library\n#pragma once\n")
        z.writestr(f"{LIB}/src/model-parameters/model_metadata.h", "#define EI_CLASSIFIER_LABEL_COUNT 5\n")
    return buf.getvalue()


class FakeEI:
    def __init__(self, api_key, fail_jobs=False):
        self.api_key = api_key
        self.fail_jobs = fail_jobs
        self.uploads = []
        self.requests = []
        self.jobs = {}
        self._next_job = 1
        self.lock = threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _send(self, code, body, ctype="application/json"):
                data = body if isinstance(body, bytes) else json.dumps(body).encode()
                self.send_response(code)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _handle(self, method):
                n = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(n) if n else b""
                with fake.lock:
                    fake.requests.append(f"{method} {self.path}")
                if self.headers.get("x-api-key") != fake.api_key:
                    return self._send(401, {"success": False, "error": "Invalid API key"})
                code, res, ctype = fake.route(method, self.path, self.headers, body)
                self._send(code, res, ctype)

            def do_GET(self):
                self._handle("GET")

            def do_POST(self):
                self._handle("POST")

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def start(self):
        threading.Thread(target=self.httpd.serve_forever, daemon=True, name="fake-ei").start()
        return self

    def stop(self):
        self.httpd.shutdown()

    def _summary(self, cat):
        ups = [u for u in self.uploads if u["category"] == cat]
        return {"dataCount": len(ups),
                "totalLengthMs": sum(len(u["doc"]["payload"]["values"]) * u["doc"]["payload"]["interval_ms"] for u in ups),
                "labels": sorted({u["label"] for u in ups})}

    def route(self, method, path, headers, body):
        ok = lambda d: (200, {"success": True, **d}, "application/json")
        p = path.split("?")[0]
        m = re.fullmatch(r"/api/(training|testing)/data", p)
        if m and method == "POST":
            doc = json.loads(body)
            with self.lock:
                self.uploads.append({"category": m.group(1), "label": headers.get("x-label"),
                                     "file": headers.get("x-file-name"), "doc": doc})
            return 200, f"{headers.get('x-label')}.{len(self.uploads)}.json".encode(), "text/plain"
        if p == "/v1/api/projects":
            return ok({"projects": [{"id": PID, "name": "Ardu Kart wheel", "owner": "Workshop"}]})
        if p == f"/v1/api/{PID}":
            return ok({"project": {"id": PID, "name": "Ardu Kart wheel", "owner": "Workshop"},
                       "dataSummaryPerCategory": {"training": self._summary("training"),
                                                  "testing": self._summary("testing")}})
        if p == f"/v1/api/{PID}/impulse":
            return ok({"impulse": {
                "inputBlocks": [{"type": "time-series", "windowSizeMs": 1000, "windowIncreaseMs": 250, "frequencyHz": 62.5}],
                "dspBlocks": [{"type": "spectral-analysis", "title": "Spectral Analysis"}],
                "learnBlocks": [{"type": "keras", "title": "Classifier"}]}})
        m = re.fullmatch(rf"/v1/api/{PID}/jobs/(retrain|build-ondevice-model)", p)
        if m and method == "POST":
            with self.lock:
                jid = self._next_job
                self._next_job += 1
                self.jobs[jid] = {"kind": m.group(1), "polls": 0, "body": json.loads(body or b"{}"), "query": path}
            return ok({"id": jid})
        m = re.fullmatch(rf"/v1/api/{PID}/jobs/(\d+)/(status|stdout)", p)
        if m:
            job = self.jobs.get(int(m.group(1)))
            if not job:
                return 404, {"success": False, "error": "no such job"}, "application/json"
            if m.group(2) == "stdout":
                return ok({"stdout": [{"created": "2026-01-01T00:00:00Z", "data": f"{job['kind']}: epoch 1/30\n"},
                                      {"created": "2026-01-01T00:00:01Z", "data": f"{job['kind']}: finished\n"}]})
            job["polls"] += 1
            done = job["polls"] >= 2
            return ok({"job": {"id": int(m.group(1)), "finished": "2026-01-01T00:00:02Z" if done else None,
                               "finishedSuccessful": done and not self.fail_jobs}})
        if p == f"/v1/api/{PID}/deployment/download":
            return 200, library_zip(), "application/zip"
        return 404, {"success": False, "error": f"fake EI: no route {method} {p}"}, "application/json"


if __name__ == "__main__":
    import sys
    key = sys.argv[1] if len(sys.argv) > 1 else "ei_" + "0" * 32
    srv = FakeEI(key)
    print(f"fake Edge Impulse on {srv.url} (API key {key})")
    print(f"  ARDUKART_EI_STUDIO_URL={srv.url}/v1/api ARDUKART_EI_INGEST_URL={srv.url}")
    srv.httpd.serve_forever()
