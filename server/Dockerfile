FROM golang:1.22-alpine AS builder

WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -o vault-sync .

FROM alpine:3.19

RUN apk --no-cache add ca-certificates

WORKDIR /app

COPY --from=builder /app/vault-sync .

EXPOSE 8443

CMD ["./vault-sync"]
