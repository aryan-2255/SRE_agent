---
name: incident-postmortem
description: Template and rules for a short blameless postmortem after an incident is resolved.
---

# Blameless postmortem

Write for an engineer who wasn't there. Plain language, facts with times, no blame.

```markdown
# <INC-id>: <one-line summary>

**Impact:** who was affected, how many requests or users, for how long.
**Duration:** detected <time> · mitigated <time> · resolved <time>

## Timeline
- hh:mm alert: <signal and numbers>
- hh:mm root cause found: <what>
- hh:mm mitigation approved by <who> via <Jira/dashboard>: <action>
- hh:mm recovered: <numbers>
- hh:mm fix merged and promoted: <PR link>

## Root cause
What broke and why, with the evidence (log line, trace link, commit).

## What we did
Mitigation, then the permanent fix, and how each was verified.

## What we'll change
1–3 concrete follow-ups (a test, an alert, a guard).
```

Keep it under 300 words. Use the real numbers from the incident, not estimates.
