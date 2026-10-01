import { describe, expect, test } from "vitest";
import { createServer } from "node:net";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, requestOrDefer } from "../src/hook/client";

describe("request", () => {
  test("rejects when no daemon is listening", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bs-client-"));
    await expect(request(join(dir, "missing.sock"), { kind: "ping" })).rejects.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  test("times out rather than hanging forever", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bs-client-"));
    const socket = join(dir, "slow.sock");
    // Draining (not answering) the client's write avoids leaving unread bytes on the
    // socket, which would otherwise keep it open and hang server.close() below.
    const server = createServer((conn) => conn.resume());
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    await expect(request(socket, { kind: "ping" }, 50)).rejects.toThrow(/timed out/);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  test("decodes a newline-framed JSON response split inside a multibyte character", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bs-client-"));
    const socket = join(dir, "split-utf8.sock");
    const payload = Buffer.from(`${JSON.stringify({ kind: "error", message: "café 😀" })}\n`);
    const split = payload.indexOf(Buffer.from("é")) + 1;
    const server = createServer((conn) => {
      conn.on("data", () => {
        conn.write(payload.subarray(0, split));
        setTimeout(() => conn.end(payload.subarray(split)), 20);
      });
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      await expect(request(socket, { kind: "ping" })).resolves.toEqual({ kind: "error", message: "café 😀" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("requestOrDefer", () => {
  test("returns undefined instead of throwing when the daemon is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bs-client-"));
    await expect(requestOrDefer(join(dir, "missing.sock"), { kind: "ping" })).resolves.toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  test("unlinks a socket file nothing listens on, so the next daemon can bind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bs-client-"));
    const socket = join(dir, "stale.sock");
    writeFileSync(socket, "");
    await requestOrDefer(socket, { kind: "ping" }, 50);
    expect(existsSync(socket)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("keeps the socket of a daemon that is merely slow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bs-client-"));
    const socket = join(dir, "slow.sock");
    // Draining (not answering) the client's write avoids leaving unread bytes on the
    // socket, which would otherwise keep it open and hang server.close() below.
    const server = createServer((conn) => conn.resume());
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    await expect(requestOrDefer(socket, { kind: "ping" }, 50)).resolves.toBeUndefined();
    expect(existsSync(socket)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });
});
