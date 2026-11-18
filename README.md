# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Gambitz25/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Gambitz25/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone git forge in one Node process, standard library only, no git binary: git smart
HTTP (upload-pack protocol v2 with ls-refs and fetch incl. shallow deepen, receive-pack v0
with report-status and fast-forward enforcement), the REST v3 API (repositories, contents,
branches, commits, git refs, labels, issues, comments, pull requests with squash merges),
the GraphQL v4 documents gh and github-mcp-server send (including the __type introspection
they feature-detect with), and a Streamable-HTTP MCP endpoint whose tools act on the same
store as REST.

One in-memory, content-addressed object store backs every surface, so an object created over
any of them reads back identically over the others. The token's identity is the suite's
seeded viewer (sdk/conformance/wire.ts `buildScenario().viewer`); a repository answers only
under its owner's login. Timestamps come from a deterministic clock seeded by
MAKEFUN_TRIAL_NOW, so a replayed trial reproduces the same state.

Local verification with the kit's own runner (sdk/run.ts): **120/120 conformance checks**
(feature 600/600, agent-native 200/200) and 158–171 of 200 performance points across runs on
a shared VM (push ≈ 36, clone 31–46, read 46–50, write 37–46).

Layout: `main.ts` is the kit's entry↔env lifecycle, unchanged; `app.ts` wires the HTTP
surfaces; `store.ts` is the object/repo store; `gitproto.ts` the pack protocol; `rest.ts`,
`graphql.ts` and `mcp.ts` the three API surfaces.

## License

MIT — see `LICENSE`.
