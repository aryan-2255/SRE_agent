#!/usr/bin/env bash
# One command to run the whole Astronomy Shop (31 containers) with Docker Compose.
#   ./shop.sh start     start everything (shop + monitoring + AI assistant)
#   ./shop.sh stop      stop and remove all containers (images stay)
#   ./shop.sh status    list containers with health and memory use
#   ./shop.sh logs X    follow the logs of one container, e.g. ./shop.sh logs payment
#   ./shop.sh rebuild X rebuild one service from this repo's source and restart it
#   ./shop.sh public    share the shop (only the shop) on a public Cloudflare link
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE=(docker compose --env-file .env --env-file .env.override
  -f compose.yaml            # core shop services
  -f compose.full.yaml       # Kafka, accounting, fraud detection
  -f compose.observability.yaml  # Grafana, Prometheus, Jaeger, OpenSearch
  -f compose.extras.yaml     # local customizations (always last)
  -f compose.agent.yaml)     # AI shopping assistant: agent, chatbot, mcp

case "${1:-}" in
  start)
    "${COMPOSE[@]}" up --detach --remove-orphans
    echo
    echo "Shop:            http://localhost:8080"
    echo "Grafana:         http://localhost:8080/grafana/"
    echo "Jaeger traces:   http://localhost:8080/jaeger/ui"
    echo "Load generator:  http://localhost:8080/loadgen/"
    echo "Failure flags:   http://localhost:8080/feature/"
    echo "AI assistant:    http://localhost:8080/chatbot/"
    echo "Prometheus:      http://localhost:9090"
    ;;
  stop)    "${COMPOSE[@]}" down ;;
  status)  "${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}'
           docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}' ;;
  logs)    "${COMPOSE[@]}" logs -f --tail 100 "${2:?service name}" ;;
  rebuild) "${COMPOSE[@]}" build "${2:?service name}"
           "${COMPOSE[@]}" up --detach --no-deps "$2" ;;
  public)
    docker compose -p shop-public -f compose.public.yaml up --detach
    echo "Public link (shop only, admin pages blocked). Keep this running:"
    cloudflared tunnel --no-autoupdate --url http://localhost:8088 ;;
  *) sed -n 2,8p "$0"; exit 1 ;;
esac
