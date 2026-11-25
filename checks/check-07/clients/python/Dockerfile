FROM python:3.14.10-slim-trixie@sha256:22eafb370920ad8b429e0aec3fff433e0669968519f5d60469d83729c138b28b
WORKDIR /sdk
COPY requirements.txt ./
RUN pip install --no-cache-dir --disable-pip-version-check --require-hashes -r requirements.txt
COPY export.py ./
