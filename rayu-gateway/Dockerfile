# Multi-stage build for the Rayu streaming gateway.
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/gateway ./cmd/gateway

# Alpine final stage: ca-certificates for upstream HTTPS, wget for healthcheck.
FROM alpine:3.20
RUN apk add --no-cache ca-certificates wget && adduser -D -u 10001 rayu
COPY --from=build /out/gateway /usr/local/bin/gateway
USER rayu
EXPOSE 8080
ENTRYPOINT ["gateway"]
