# Stage 1: Build Tesla VCP signing proxy (Go)
FROM golang:1.22-alpine AS proxy-builder
RUN go install github.com/teslamotors/vehicle-command/cmd/tesla-http-proxy@latest

# Stage 2: Build Node.js app
FROM node:20-alpine AS node-builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 3: Production image
FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY --from=proxy-builder /root/go/bin/tesla-http-proxy /usr/local/bin/
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=node-builder /app/dist ./dist
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh
EXPOSE 3000
CMD ["./entrypoint.sh"]
