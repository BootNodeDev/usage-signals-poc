"""OpenTelemetry SDK for Python: one OTLP/HTTP (protobuf) metrics export per repetition.

Each repetition has its own exporter and its own host name, with the exporter's default
settings. Usage: python export.py '<case as JSON>'. Prints one line: RESULT <json>.
"""

import json
import logging
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import InMemoryMetricReader, MetricExportResult
from opentelemetry.sdk.resources import Resource

case = json.loads(sys.argv[1])
messages: dict[int, list[str]] = {}


class PerThread(logging.Handler):
    """Keeps what the SDK logs, by the thread that logged it."""

    def emit(self, record: logging.LogRecord) -> None:
        messages.setdefault(threading.get_ident(), []).append(record.getMessage()[:300])


logging.getLogger("opentelemetry").addHandler(PerThread())
logging.getLogger("opentelemetry").propagate = False

reader = InMemoryMetricReader()
provider = MeterProvider(
    metric_readers=[reader], resource=Resource.create({"service.name": "check-07-python"})
)
provider.get_meter("check-07").create_counter("check07.requests").add(1)
metrics_data = reader.get_metrics_data()


def send(exporter: OTLPMetricExporter) -> dict:
    t0 = time.time()
    result = exporter.export(metrics_data)
    rep = {"t0": round(t0 * 1000), "elapsedMs": round((time.time() - t0) * 1000)}
    if result is MetricExportResult.SUCCESS:
        return {**rep, "outcome": "ok"}
    logged = messages.get(threading.get_ident(), [])
    return {**rep, "outcome": "error", "error": logged[-1] if logged else "export failed"}


def export_once(host: str) -> dict:
    exporter = OTLPMetricExporter(endpoint=f"http://{host}:{case['port']}/v1/metrics")
    if "offsetsMs" not in case:
        return {"host": host, **send(exporter)}
    # The same exporter sends again later, on whatever connection it kept.
    start = time.time()
    sends = []
    for offset in case["offsetsMs"]:
        time.sleep(max(0.0, start + offset / 1000 - time.time()))
        sends.append(send(exporter))
    return {"host": host, "sends": sends}


with ThreadPoolExecutor(max_workers=len(case["hosts"])) as pool:
    futures = []
    for host in case["hosts"]:
        futures.append(pool.submit(export_once, host))
        time.sleep(case["staggerMs"] / 1000)
    reps = [future.result() for future in futures]
print("RESULT " + json.dumps({"reps": reps}))
