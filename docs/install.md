# Installation

```bash
bun add ts-git-lfs
```

```bash
npm install ts-git-lfs
```

## The CLI

The library is the product, but a binary is useful for trying it against a real
`git lfs push`:

```bash
bunx ts-git-lfs serve --root ./lfs --port 8080 --write
```

Then point a repository at it:

```bash
git config lfs.url http://localhost:8080
git lfs push origin main
```

`--write` allows anonymous uploads, which is only ever right on a laptop. Without
it the server reads and refuses to write.
