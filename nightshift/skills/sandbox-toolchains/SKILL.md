---
name: sandbox-toolchains
description: How to clone a service from the system's repo into the sandbox, install its language toolchain, write a reproduction test with mocks, and run it. Use before running any code in the sandbox.
---

# Working in the sandbox

The sandbox is an isolated Linux machine (Python 3.13, git, curl). It has **no access to the live system** and **no secrets**. It can reach GitHub and package registries only. Everything you prove here must be self-contained.

## 1. Clone only what you need

```bash
git clone --depth 20 --filter=blob:none --sparse "$REPO_URL" repo
cd repo
# if the system's repo has a subdir (system.repo.subdir), the service lives under it:
git sparse-checkout set "$SUBDIR/$SERVICE_PATH"   # e.g. astronomy-shop/src/payment
cd "$SUBDIR"                                      # skip when there is no subdir
git log --oneline -5 -- "$SERVICE_PATH"           # the recent commits you may be blaming
```

## 2. Toolchains

| Language | Setup | Run tests |
|---|---|---|
| JavaScript / TypeScript (Node) | `pip install -q nodejs-wheel` then `node -v && npm -v` | `npm ci --ignore-scripts` then `node --test` (built-in runner, no extra deps) |
| Python | `python -m venv .v && . .v/bin/activate && pip install -q -r requirements.txt pytest` | `pytest -q` |
| Go, C#, Java, Rust | Not available in this sandbox. Say so and reason from code and traces instead. | — |

`npm ci` may pull OpenTelemetry and gRPC packages; that is fine. If a package needs native builds, add `--ignore-scripts`.

## 3. Write the reproduction test

- Test the smallest unit that contains the suspect change (one exported function).
- Mock everything that talks to the network or other services: gRPC clients, feature-flag providers, HTTP. In Node, stub the module in `require.cache` before requiring the file under test, or wrap calls with `node:test`'s `mock.method`.
- Use the **real inputs from the incident evidence** (amounts, product ids, quantities from logs and trace attributes), with personal data removed.
- A good reproduction fails **before** the fix for the reason in the diagnosis, and passes **after**.

Node example shape:

```js
// charge.repro.test.js
const test = require('node:test');
const assert = require('node:assert');
// stub OpenFeature so the flag client returns defaults
require.cache[require.resolve('@openfeature/server-sdk')] = { exports: { OpenFeature: {
  setProviderAndWait: async () => {}, getClient: () => ({ getNumberValue: async () => 0, getBooleanValue: async () => false }) } } };
const { charge } = require('./charge');
test('accepts an amount with cents', async () => {
  const res = await charge({ amount: { currencyCode: 'USD', units: 811, nanos: 520000000 },
    creditCard: { creditCardNumber: '4432-8015-6152-0454', creditCardCvv: 672, creditCardExpirationYear: 2039, creditCardExpirationMonth: 1 } });
  assert.ok(res.transactionId);
});
```

## 4. Report honestly

Return the exact command and its real output. If the test passes when you expected it to fail, the diagnosis may be wrong: say what you saw instead.

## Limits

Keep each command under 5 minutes. Don't install global tools you don't need. Never write secrets to files.
