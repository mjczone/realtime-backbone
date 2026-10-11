# Sample only. Build context is the repo root.
FROM node:24-alpine AS web
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY ts/contract/package.json ts/contract/
COPY ts/client/package.json ts/client/
COPY ts/agui-client/package.json ts/agui-client/
COPY samples/chat-web/package.json samples/chat-web/
RUN pnpm install --frozen-lockfile --filter @realtime-samples/chat-web...
COPY ts/contract ts/contract
COPY ts/client ts/client
COPY ts/agui-client ts/agui-client
COPY samples/chat-web samples/chat-web
RUN pnpm --filter @realtime-samples/chat-web... build

FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.8.15 /uv /usr/local/bin/uv
ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
WORKDIR /repo
COPY python python
COPY samples/py-chat samples/py-chat
COPY samples/py-signals samples/py-signals
RUN cd python && uv sync --frozen --no-dev --package rtb-sample-py-chat
COPY --from=web /repo/samples/chat-web/public /web
ENV RTB_WEB_DIR=/web PATH=/repo/python/.venv/bin:$PATH
WORKDIR /repo/samples/py-chat
EXPOSE 3003
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "3003", "--no-access-log"]
