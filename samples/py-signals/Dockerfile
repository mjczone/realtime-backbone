# Sample only. Build context is the repo root.
FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.8.15 /uv /usr/local/bin/uv
ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /repo
COPY python python
COPY samples/py-chat samples/py-chat
COPY samples/py-signals samples/py-signals
RUN cd python && uv sync --frozen --no-dev --package rtb-sample-py-signals
ENV PATH=/repo/python/.venv/bin:$PATH
WORKDIR /repo/samples/py-signals
CMD ["python", "signals.py"]
