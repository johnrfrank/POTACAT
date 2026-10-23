# John's POTACAT fork

John alone submits pull requests and handles upstream communication. No agent
may submit a PR anywhere or communicate with `Waffleslop/POTACAT`: no network
requests, fetches, pushes, issues, comments or reviews. Cached upstream refs may
be used for local Git comparisons. Agents may prepare commits, branches and
draft descriptions and push them only to `johnrfrank/POTACAT`.

Use `debug/echocat-ft8` for discovery and small fixes, with normal Git commits
and diffs. Keep useful behavioral regression tests and brief debugging notes.
Do not introduce manifest systems or unrelated hardening work.

Station operation belongs to `/home/jrf/code/n9wly-cliff-house`; read its
`AGENTS.md` before touching radio hardware or station configuration. Use its
`./station` commands for routine operation. Keep the antenna lowered and fixed,
power low and the radio off when idle. Preserve the recorded ACC/PTT fault until
the observed input has been diagnosed and an actual repair recorded.
