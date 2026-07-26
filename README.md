# Pi Agent Config

Personal Pi configuration for `~/.pi/agent`.

## What is tracked

- `settings.json`
- `AGENTS.md`
- local extension/skill/theme source files
- `package.json` and `package-lock.json` for local extension dependencies
- TypeScript/config files

## What is intentionally ignored

- `auth.json` and `.env*` secrets
- `sessions/` conversation history
- `node_modules/`
- package install caches: `npm/`, `git/`
- model/provider caches such as `models-store.json`
- disabled/backup experiment folders

## Restore on a new machine

```sh
git clone <your-repo-url> ~/.pi/agent
cd ~/.pi/agent
npm install
pi
```

Then authenticate with `/login` or restore secrets manually if needed.
