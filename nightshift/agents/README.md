# NightShift agents

Thirteen saved TrueForge agents, one job each. `scripts/setup_trueforge.py` loads these files into TrueForge (create or update) and fills in the models configured there: **small** = a fast, cheap model for routine steps (default `gpt-5.4-mini`), **strong** = a reasoning model for diagnosis, planning and code (default `gpt-5.5`).

Every agent answers with one JSON object matching its schema, always including `summary` and `confidence`, so the orchestrator can chain them without parsing prose.

| Agent | Job | Model | Tools it may use | Pauses for approval before | Runtime | Must return |
|---|---|---|---|---|---|---|
| `ns-triage` | Confirms an alert is real, sets severity and category, picks the path. | small | nightshift-ops: get_error_rates, get_metrics, list_services, get_flags, get_recent_deploys | – | – | `summary`, `confidence`, `real_incident`, `severity`, `service`, `category` |
| `ns-diagnosis` | Finds the root cause with parallel sub-agents over logs, traces, commits and past incidents. | strong | nightshift-ops: list_services, get_error_rates, get_metrics, query_logs, get_traces, get_trace, get_recent_deploys, get_flags, run_sql_readonly, synthetic_check<br>github: list_commits, get_commit, get_file_contents, search_code<br>nightshift-knowledge: search_incidents, search_docs<br>nightshift-codegraph: blast_radius, commits_touching, service_dependencies | – | parallel sub-agents | `summary`, `confidence`, `root_cause`, `evidence` |
| `ns-validator` | Tries to disprove the root cause and reproduces the bug with a failing test in the sandbox. | strong | github: get_file_contents, get_commit | – | sandbox | `summary`, `confidence`, `reproduced`, `run_output` |
| `ns-planner` | Proposes fixes with risk and blast radius and picks the safest. | strong | nightshift-ops: get_recent_deploys, get_flags, list_services<br>nightshift-codegraph: blast_radius, service_dependencies<br>nightshift-knowledge: search_incidents | – | – | `summary`, `confidence`, `options`, `chosen`, `mitigation`, `fix_needed` |
| `ns-mitigator` | Stops the damage with the most reversible action. Every change waits for approval. | small | nightshift-ops: rollback, set_flag, restart_service, scale_service, get_error_rates, get_recent_deploys, get_flags | `rollback`, `set_flag`, `restart_service`, `scale_service` | – | `summary`, `confidence`, `action_taken`, `result` |
| `ns-verifier` | Checks the live system recovered after a change. | small | nightshift-ops: get_error_rates, synthetic_check, get_traces | – | – | `summary`, `confidence`, `recovered` |
| `ns-coder` | Writes the smallest code fix (or a new tool) and runs the tests in the sandbox. | strong | github: get_file_contents, get_commit | – | sandbox | `summary`, `confidence`, `patch`, `files` |
| `ns-tester` | Runs the fix and its tests in a clean sandbox. | small | github: get_file_contents | – | sandbox | `summary`, `confidence`, `passed`, `output` |
| `ns-pr` | Opens the pull request with the fix. Waits for approval. | small | github: create_branch, push_files, create_pull_request, get_file_contents | `create_branch`, `push_files`, `create_pull_request` | – | `summary`, `confidence`, `pr_url` |
| `ns-reviewer` | Reviews the fix like a senior engineer and comments on the PR. | strong | github: pull_request_read, get_file_contents, pull_request_review_write, create_pending_pull_request_review, add_comment_to_pending_review, submit_pending_pull_request_review | – | – | `summary`, `confidence`, `verdict` |
| `ns-cicd` | Merges after CI, ships a 10% canary, checks it, then promotes. Every step waits for approval. | small | github: pull_request_read, merge_pull_request, list_workflow_runs<br>nightshift-ops: deploy, deploy_canary, promote_canary, abort_canary, get_error_rates, synthetic_check | `merge_pull_request`, `deploy`, `deploy_canary`, `promote_canary` | – | `summary`, `confidence`, `promoted` |
| `ns-postmortem` | Writes the postmortem, notifies the team and saves the lesson. | small | nightshift-ops: notify<br>nightshift-knowledge: save_postmortem | `notify` | – | `summary`, `confidence`, `postmortem_md` |
| `ns-docs` | Finds official docs for a third-party provider and saves them for the other agents. | strong | exa: @all<br>nightshift-knowledge: save_docs, search_docs<br>github: get_file_contents | – | – | `summary`, `confidence`, `provider`, `sources` |

## Safety rules built into every agent

- Tools that change the system are listed **by name** under "pauses for approval". TrueForge stops the call and NightShift asks a person on Jira or the dashboard. (TrueForge only gates tools the server marks destructive by default, and many servers mark nothing, so we never rely on that.)
- Agents get only the tools their job needs. Diagnosis can read everything but change nothing.
- Code runs only in TrueForge's sandbox, which has no secrets and no access to the live system.
- Every claim must cite evidence (log line, trace, commit, metric); agents are told never to invent tool output.
