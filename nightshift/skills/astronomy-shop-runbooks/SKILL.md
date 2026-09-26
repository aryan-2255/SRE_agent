---
name: astronomy-shop-runbooks
description: Architecture, service roles, failure switches and safe mitigations for the Astronomy Shop demo system.
---

# Astronomy Shop runbook

An online telescope shop of ~25 services in many languages, run with Docker Compose. Traffic enters through `frontend-proxy` (Envoy, :8080) → `frontend` (Next.js). A purchase flows frontend → checkout → cart (Valkey), product-catalog (Postgres), currency, shipping → quote, **payment**, email, then an order event to Kafka (read by accounting and fraud-detection). Checkout reaches payment through `payment-lb` (nginx), which splits traffic for canary deploys.

Signals: logs in OpenSearch, metrics in Prometheus (span metrics per service), traces in Jaeger. Load-generator traffic is marked synthetic; real users are not.

## Safe mitigations, most reversible first

| Symptom | First action | Then |
|---|---|---|
| Errors right after a deploy of one service | `rollback` that service (seconds, no rebuild) | fix forward with a PR |
| A feature flag was changed | `set_flag` back to the previous value | find who changed it |
| Out of memory / restarts | `restart_service`, then `scale_service` | raise the memory limit in a PR |
| Slow product pages with DB lock waits | turn off `productCatalogLockContention` if on | review queries |
| Payment provider unreachable (external) | do nothing to our code; escalate | status page |

## Failure switches (flagd) and what they break

See `references/flags.md`.
