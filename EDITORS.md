# Editor setup

The language server (`@drafteine/language-server`) speaks standard LSP over
stdio, so any LSP-capable editor gets diagnostics, completions with docs,
hover, formatting, symbols, and folding from the same binary.

Until the npm packages are published, the server command is:

```sh
node /path/to/drafteine/packages/language-server/dist/server.js --stdio
```

After publishing it becomes `drafteine-language-server --stdio`. The
snippets below use the short form.

## VS Code

Install the packaged extension and reload:

```sh
code --install-extension packages/vscode-extension/drafteine-*.vsix
```

Everything is included: language server, syntax highlighting, preview
panel, markdown fence rendering, contract watcher, apply command.

## Neovim (0.10+)

```lua
vim.filetype.add({ extension = { dft = "drafteine" } })
vim.api.nvim_create_autocmd("FileType", {
  pattern = "drafteine",
  callback = function()
    vim.lsp.start({
      name = "drafteine",
      cmd = { "drafteine-language-server", "--stdio" },
      root_dir = vim.fs.root(0, { "drafteine.config.json", ".git" }),
    })
  end,
})
```

Folding, hover, completion, and diagnostics work out of the box. For a
preview, pipe the buffer through the CLI:
`:!drafteine tree %` or bind a split that runs it on save.

## Helix

```toml
# languages.toml
[language-server.drafteine]
command = "drafteine-language-server"
args = ["--stdio"]

[[language]]
name = "drafteine"
scope = "source.drafteine"
file-types = ["dft"]
language-servers = ["drafteine"]
```

## Zed

Zed reaches external language servers through extensions; until a
dedicated one exists, use the CLI (`drafteine check --all`, `tree`) in
Zed's terminal.

## Sublime Text (LSP package)

```json
{
  "clients": {
    "drafteine": {
      "enabled": true,
      "command": ["drafteine-language-server", "--stdio"],
      "selector": "source.drafteine"
    }
  }
}
```

## Emacs (eglot)

```elisp
(add-to-list 'auto-mode-alist '("\\.dft\\'" . text-mode))
(add-to-list 'eglot-server-programs
             '(text-mode . ("drafteine-language-server" "--stdio")))
```

## JetBrains

Planned, not yet built. JetBrains IDEs support LSP-based plugins, and the
HTML preview ports to JCEF nearly verbatim. Until then the CLI works in
the built-in terminal.

## Terminals and everything else

`drafteine tree` renders ASCII, `tree --json` emits structured data for
custom tooling, and every verb reads stdin with `-`.
