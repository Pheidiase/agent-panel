# Contributing

Keep changes focused and describe the problem, resulting behavior and validation in your pull request. Discuss architectural changes before implementing them.

Use the supported Node.js range from `package.json`. Install dependencies with `npm ci`, then run:

```sh
npm test
npm run build
```

Use ES modules, existing naming/formatting and short comments. Do not add dependencies or refactor unrelated code without discussion. Add meaningful regression tests for behavior changes. Tests must use temporary state and fake agent processes; never send real model prompts or messages. Some integration tests require subprocesses, tmux and loopback networking; report sandbox restrictions explicitly.

UI strings belong in both `src/locales/en.ts` and `src/locales/tr.ts`. Keep translation keys and placeholders aligned. Do not translate user content, protocol fields or project paths.

Before a PR, check `git diff --check`, review the diff for personal data and secrets, and verify local authentication, the owner-only portal boundary and existing configuration behavior when relevant. Never include runtime state, credentials, private transcripts, generated build files or dependency directories. Report security issues through [SECURITY.md](SECURITY.md).

By submitting a contribution, you agree that it is licensed under the MIT License of this project.
