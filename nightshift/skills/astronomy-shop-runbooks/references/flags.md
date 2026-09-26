# Failure switches

| Flag | What it breaks | Values |
|---|---|---|
| `adFailure` | Fail ad service | off, on |
| `adHighCpu` | Triggers high cpu load in the ad service | off, on |
| `adManualGc` | Triggers full manual garbage collections in the ad service | off, on |
| `aiRunawayAgent` | forces the agent to keep looping tool calls until it hits its recursion limit | off, on |
| `aiSlowResponse` | slow LLM responses in the agent service | 10sec, 5sec, off |
| `cartFailure` | Fail cart service n% of the time | 10%, 100%, 25%, 50%, 75%, 90%, off |
| `emailMemoryLeak` | Memory leak in the email service. | 10000x, 1000x, 100x, 10x, 1x, off |
| `emitRawPii` | Emit raw PII attributes (user.email, demo.payment.card_number, demo.payment.card_cvv) from checkout and payment for the collector redaction example. Not a failure scenario -- controls PII emission, independent of collector-side redaction which always runs. | off, on |
| `failedReadinessProbe` | readiness probe failure for cart service | off, on |
| `imageSlowLoad` | slow loading images in the frontend | 10sec, 5sec, off |
| `intlShippingSlowdown` | Delays international shipping responses to simulate overseas shipping delay | 10sec, 5sec, off |
| `kafkaQueueProblems` | Overloads Kafka queue while simultaneously introducing a consumer side delay leading to a lag spike | off, on |
| `loadGeneratorFloodHomepage` | Flood the frontend with a large amount of requests. | off, on |
| `paymentFailure` | Fail payment service charge requests n% | 10%, 100%, 25%, 50%, 75%, 90%, off |
| `paymentUnreachable` | Payment service is unavailable | off, on |
| `productCatalogFailure` | Fail product catalog service on a specific product | off, on |
| `productCatalogLockContention` | Trigger lock contention on the product catalog database | off, on |
| `recommendationCacheFailure` | Fail recommendation service cache | off, on |
