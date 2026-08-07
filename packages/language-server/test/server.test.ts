/**
 * Protocol smoke test: spawn the server over stdio, speak raw JSON-RPC
 * (Content-Length framing), and verify initialize, diagnostics — including
 * UTF-16 offset correctness on a line containing an emoji — completions,
 * and formatting.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const serverPath = new URL("../dist/server.js", import.meta.url).pathname;

class LspClient {
  private proc: ChildProcess;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, (result: unknown) => void>();
  private notificationWaiters: Array<{
    method: string;
    resolve: (params: unknown) => void;
  }> = [];

  constructor() {
    this.proc = spawn(process.execPath, [serverPath, "--stdio"], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.proc.stdout!.on("data", (chunk: Buffer) => this.onData(chunk));
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.buffer.subarray(0, headerEnd).toString();
      const m = /Content-Length: (\d+)/i.exec(header);
      if (!m) throw new Error("bad LSP header: " + header);
      const length = Number(m[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = JSON.parse(
        this.buffer.subarray(bodyStart, bodyStart + length).toString()
      );
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.dispatch(body);
    }
  }

  private dispatch(msg: {
    id?: number;
    method?: string;
    result?: unknown;
    params?: unknown;
  }): void {
    if (msg.id !== undefined && msg.method === undefined) {
      this.pending.get(msg.id)?.(msg.result);
      this.pending.delete(msg.id);
    } else if (msg.method) {
      const i = this.notificationWaiters.findIndex((w) => w.method === msg.method);
      if (i >= 0) {
        const [w] = this.notificationWaiters.splice(i, 1);
        w.resolve(msg.params);
      }
    }
  }

  private send(msg: object): void {
    const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
    this.proc.stdin!.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  request(method: string, params: object): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ id, method, params });
    });
  }

  notify(method: string, params: object): void {
    this.send({ method, params });
  }

  waitFor(method: string): Promise<unknown> {
    return new Promise((resolve) =>
      this.notificationWaiters.push({ method, resolve })
    );
  }

  kill(): void {
    this.proc.kill();
  }
}

test("initialize, diagnostics (with emoji offsets), completion, formatting", async () => {
  const client = new LspClient();
  try {
    const init = (await client.request("initialize", {
      processId: null,
      rootUri: null,
      capabilities: {},
    })) as { capabilities: Record<string, unknown> };
    assert.ok(init.capabilities.completionProvider);
    assert.ok(init.capabilities.documentSymbolProvider);
    client.notify("initialized", {});

    // Emoji before the error: 🚀 is 2 UTF-16 units — range must still land
    // on the annotation junk, not drift.
    // Trailing blank-line run makes the doc unformatted, so formatting
    // returns a real edit below.
    const text = "app/\n  🚀 rocket.txt @@bad\n\n\n";
    const uri = "file:///draft.dft";
    const diagsPromise = client.waitFor("textDocument/publishDiagnostics");
    client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "drafteine", version: 1, text },
    });
    const diags = (await diagsPromise) as {
      diagnostics: Array<{ range: { start: { line: number; character: number } }; message: string }>;
    };
    assert.equal(diags.diagnostics.length, 1);
    assert.match(diags.diagnostics[0].message, /Expected @annotation/);
    assert.equal(diags.diagnostics[0].range.start.line, 1);
    // "  🚀 rocket.txt " = 2 + 2 + 1 + 10 + 1 = 16 UTF-16 units
    assert.equal(diags.diagnostics[0].range.start.character, 16);

    const completions = (await client.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 0, character: 4 },
    })) as Array<{ label: string }>;
    const labels = completions.map((c) => c.label);
    assert.ok(labels.includes("@strict")); // folder line offers @strict
    assert.ok(labels.includes("@template"));

    // Document symbols must round-trip the client's strict DocumentSymbol
    // validation: every position a real uinteger column, never a sentinel.
    const symbols = (await client.request("textDocument/documentSymbol", {
      textDocument: { uri },
    })) as Array<{
      name: string;
      range: { start: { character: number }; end: { line: number; character: number } };
      selectionRange: unknown;
      children: unknown[];
    }>;
    assert.equal(symbols.length, 1);
    assert.equal(symbols[0].name, "app/");
    assert.equal(symbols[0].children.length, 1);
    const flat = [symbols[0], ...(symbols[0].children as typeof symbols)];
    for (const sym of flat) {
      assert.ok(sym.selectionRange, "selectionRange present");
      assert.ok(
        sym.range.end.character <= 2147483647 && Number.isInteger(sym.range.end.character),
        `end.character is a valid uinteger, got ${sym.range.end.character}`
      );
    }

    // Folding ranges are what give the editor its folder-collapse arrows.
    const folds = (await client.request("textDocument/foldingRange", {
      textDocument: { uri },
    })) as Array<{ startLine: number; endLine: number }>;
    assert.equal(folds.length, 1);
    assert.equal(folds[0].startLine, 0); // app/ folds over its child

    const edits = (await client.request("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true },
    })) as Array<{ newText: string }>;
    assert.equal(edits.length, 1); // trailing blank collapses, error line kept
    assert.match(edits[0].newText, /app\//);

    // Quick fix for an indentation warning must produce a real edit.
    const uri2 = "file:///fix.dft";
    const diags2Promise = client.waitFor("textDocument/publishDiagnostics");
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri: uri2,
        languageId: "drafteine",
        version: 1,
        text: "app/\n  a/\n   odd.txt\n",
      },
    });
    const diags2 = (await diags2Promise) as {
      diagnostics: Array<{ range: unknown; message: string }>;
    };
    const indentDiag = diags2.diagnostics.find((d) => /multiple of/.test(d.message));
    assert.ok(indentDiag, "indentation warning present");
    const actions = (await client.request("textDocument/codeAction", {
      textDocument: { uri: uri2 },
      range: indentDiag!.range,
      context: { diagnostics: [indentDiag] },
    })) as Array<{ title: string; edit: { changes: Record<string, Array<{ newText: string }>> } }>;
    assert.equal(actions[0]?.title, "Fix indentation");
    assert.equal(actions[0].edit.changes[uri2][0].newText, "  ");

    await client.request("shutdown", {});
  } finally {
    client.kill();
  }
});

test("config language: validated as config, never parsed as a draft", async () => {
  const client = new LspClient();
  try {
    await client.request("initialize", { processId: null, rootUri: null, capabilities: {} });
    client.notify("initialized", {});
    const uri = "file:///drafteine.config.json";
    const diagsPromise = client.waitFor("textDocument/publishDiagnostics");
    client.notify("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: "drafteine-config",
        version: 1,
        text: JSON.stringify({
          contract: ["typo.dft"],
          profiles: [{ name: "pkg", expands: { strict: null } }],
        }),
      },
    });
    const diags = (await diagsPromise) as { diagnostics: Array<{ message: string }> };
    const messages = diags.diagnostics.map((d) => d.message);
    assert.ok(messages.some((m) => /Unknown key "contract"/.test(m)), "unknown key flagged");
    assert.ok(
      messages.some((m) => /may not expand @strict/.test(m)),
      "profile boundary enforced"
    );
    // No draft-parser noise: nothing about indentation or annotations syntax.
    assert.ok(!messages.some((m) => /Expected @annotation/.test(m)));

    // Formatting pretty-prints config JSON with key order preserved.
    const edits = (await client.request("textDocument/formatting", {
      textDocument: { uri },
      options: { tabSize: 2, insertSpaces: true },
    })) as Array<{ newText: string }>;
    assert.equal(edits.length, 1);
    assert.match(edits[0].newText, /^\{\n  "contract"/);
    assert.ok(edits[0].newText.endsWith("\n"));

    // Brace folding works for the config document.
    const folds = (await client.request("textDocument/foldingRange", {
      textDocument: { uri: uri },
    })) as unknown[];
    assert.equal(Array.isArray(folds), true);
    await client.request("shutdown", {});
  } finally {
    client.kill();
  }
});

test("declared vocabulary from drafteine.config.json completes and documents", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "drafteine-lsp-"));
  fs.writeFileSync(
    path.join(dir, "drafteine.config.json"),
    JSON.stringify({
      annotations: [
        { name: "owner", value: "string", doc: "Team that owns this entry." },
        { name: "generated", value: "flag", appliesTo: "file" },
      ],
    })
  );
  const client = new LspClient();
  try {
    await client.request("initialize", {
      processId: null,
      rootUri: null,
      workspaceFolders: [{ uri: pathToFileURL(dir).href, name: "tmp" }],
      capabilities: {},
    });
    client.notify("initialized", {});
    const uri = "file:///vocab.dft";
    client.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "drafteine", version: 1, text: "main.ts\n" },
    });
    const completions = (await client.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 0, character: 7 },
    })) as Array<{ label: string; documentation?: { value: string } }>;
    const owner = completions.find((c) => c.label === "@owner");
    assert.ok(owner, "custom @owner completion missing");
    assert.match(owner.documentation?.value ?? "", /Team that owns this entry/);
    assert.ok(completions.some((c) => c.label === "@generated"));
    await client.request("shutdown", {});
  } finally {
    client.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
