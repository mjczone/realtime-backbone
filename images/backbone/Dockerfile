ARG CENTRIFUGO_VERSION=v6.9.7

FROM golang:1.26-alpine AS doctor
WORKDIR /src
COPY tools/doctor/go.mod tools/doctor/go.sum ./
RUN go mod download
COPY tools/doctor/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /realtime-doctor .

FROM centrifugo/centrifugo:${CENTRIFUGO_VERSION}
ARG CENTRIFUGO_VERSION
LABEL org.opencontainers.image.title="realtime-backbone" \
      org.opencontainers.image.description="Centrifugo with the realtime-backbone config and realtime-doctor" \
      org.opencontainers.image.licenses="MIT AND Apache-2.0" \
      dev.realtime-backbone.centrifugo.version="${CENTRIFUGO_VERSION}"
COPY --from=doctor /realtime-doctor /usr/local/bin/realtime-doctor
COPY config/centrifugo.json /centrifugo/config.json
EXPOSE 8000 9000 10000
ENTRYPOINT ["realtime-doctor", "exec", "--"]
CMD ["centrifugo", "-c", "config.json"]
