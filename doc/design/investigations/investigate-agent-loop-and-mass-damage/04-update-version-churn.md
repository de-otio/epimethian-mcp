# 4. Version churn via `update_page`

[← back to index](README.md)

Distinct from [finding 3](03-status-version-churn.md) because
`update_page` *does* require a version number (optimistic concurrency),
so the agent must at least observe the current version. But it can
still loop:

```
v = get_page(id).version
update_page(id, body=X, version=v)    # → v+1
update_page(id, body=X, version=v+1)  # → v+2  (body unchanged, still writes)
…
```

`_rawUpdatePage` submits a new version whether or not `body` changed
byte-for-byte against the current storage. The guards catch shrinkage
and structure loss but not "you just rewrote the same content". This is
a subtler version-history pollution than finding 3 — the body actually
changes in each iteration iff the agent is mangling it each time.

## Possible mitigation

Compare `pageBody` (post-strip-attribution, post-conversion) against
`previousBody`. If byte-identical, short-circuit: return the existing
version without writing. This also defends the common "agent re-submits
its own read-back" loop.
