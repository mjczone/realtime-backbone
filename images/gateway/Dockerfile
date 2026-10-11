# realtime-gateway. Build context is the repo root.
FROM node:24-alpine AS web
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY ts/contract/package.json ts/contract/
COPY ts/client/package.json ts/client/
COPY ts/agui-client/package.json ts/agui-client/
COPY gateway/web/package.json gateway/web/
RUN pnpm install --frozen-lockfile --filter @mjczone/realtime-gateway-web...
COPY ts/contract ts/contract
COPY ts/client ts/client
COPY ts/agui-client ts/agui-client
COPY gateway/web gateway/web
RUN pnpm --filter @mjczone/realtime-gateway-web... build

FROM golang:1.26-alpine AS build
WORKDIR /src
COPY gateway/go.mod gateway/go.sum ./
RUN go mod download
COPY gateway/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /realtime-gateway .

FROM alpine:3.22
LABEL org.opencontainers.image.title="realtime-gateway" \
      org.opencontainers.image.description="Plain HTTP in front of the realtime backbone: publish, realtime tokens and AG-UI runs" \
      org.opencontainers.image.licenses="MIT"
COPY --from=build /realtime-gateway /usr/local/bin/realtime-gateway
COPY --from=web /repo/gateway/web/dist/realtime-client.js /usr/share/realtime-gateway/realtime-client.js
USER 65532
EXPOSE 8090
ENTRYPOINT ["realtime-gateway"]
