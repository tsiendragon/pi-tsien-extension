import { createHash } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";

import { truncateUtf8Tail } from "../command-ui/command-registry.ts";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Background output path is not a private directory: ${path}`);
  }
  const getuid = process.getuid;
  if (typeof getuid === "function" && metadata.uid !== getuid.call(process)) {
    throw new Error(`Background output directory is not owned by the current user: ${path}`);
  }
  await chmod(path, DIRECTORY_MODE);
}

export interface OutputAppendResult {
  readonly acceptedBytes: number;
  readonly limitReached: boolean;
  readonly backpressured: boolean;
}

export class BackgroundOutputWriter {
  readonly outputFile: string;

  private readonly stream: WriteStream;
  private readonly decoder = new StringDecoder("utf8");
  private readonly maxOutputBytes: number;
  private readonly maxTailBytes: number;
  private outputBytesValue = 0;
  private outputTailValue = "";
  private outputTruncatedValue = false;
  private closed = false;
  private streamError: Error | undefined;

  private constructor(
    outputFile: string,
    stream: WriteStream,
    maxOutputBytes: number,
    maxTailBytes: number,
  ) {
    this.outputFile = outputFile;
    this.stream = stream;
    this.maxOutputBytes = maxOutputBytes;
    this.maxTailBytes = maxTailBytes;
    stream.on("error", (error) => {
      this.streamError = error;
    });
  }

  static async create(
    outputFile: string,
    maxOutputBytes: number,
    maxTailBytes: number,
  ): Promise<BackgroundOutputWriter> {
    const stream = createWriteStream(outputFile, {
      flags: "wx",
      mode: FILE_MODE,
    });
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        stream.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        stream.off("open", onOpen);
        reject(error);
      };
      stream.once("open", onOpen);
      stream.once("error", onError);
    });
    return new BackgroundOutputWriter(outputFile, stream, maxOutputBytes, maxTailBytes);
  }

  get outputBytes(): number {
    return this.outputBytesValue;
  }

  get outputTail(): string {
    return this.outputTailValue;
  }

  get outputTruncated(): boolean {
    return this.outputTruncatedValue;
  }

  get error(): Error | undefined {
    return this.streamError;
  }

  append(chunk: Buffer): OutputAppendResult {
    if (this.closed || this.streamError || chunk.byteLength === 0) {
      return { acceptedBytes: 0, limitReached: false, backpressured: false };
    }

    const remaining = Math.max(0, this.maxOutputBytes - this.outputBytesValue);
    const accepted = remaining >= chunk.byteLength ? chunk : chunk.subarray(0, remaining);
    let backpressured = false;
    if (accepted.byteLength > 0) {
      this.outputBytesValue += accepted.byteLength;
      backpressured = !this.stream.write(accepted);
      const decoded = this.decoder.write(accepted);
      const tail = truncateUtf8Tail(this.outputTailValue + decoded, this.maxTailBytes);
      this.outputTailValue = tail.text;
      this.outputTruncatedValue = this.outputTruncatedValue || tail.truncated;
    }

    const limitReached = accepted.byteLength < chunk.byteLength
      || this.outputBytesValue >= this.maxOutputBytes;
    if (limitReached) this.outputTruncatedValue = true;
    return { acceptedBytes: accepted.byteLength, limitReached, backpressured };
  }

  onDrain(callback: () => void): void {
    this.stream.once("drain", callback);
  }

  onError(callback: (error: Error) => void): void {
    if (this.streamError) {
      queueMicrotask(() => callback(this.streamError!));
      return;
    }
    this.stream.once("error", callback);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const finalText = this.decoder.end();
    if (finalText) {
      const tail = truncateUtf8Tail(this.outputTailValue + finalText, this.maxTailBytes);
      this.outputTailValue = tail.text;
      this.outputTruncatedValue = this.outputTruncatedValue || tail.truncated;
    }
    this.stream.end();
    try {
      await finished(this.stream);
    } catch (error) {
      this.streamError = error instanceof Error ? error : new Error(String(error));
    }
  }
}

export class BackgroundOutputStore {
  private readonly rootDirectory: string;
  private sessionDirectory: string | undefined;

  constructor(rootDirectory = join(tmpdir(), "pi-background")) {
    this.rootDirectory = rootDirectory;
  }

  get directory(): string | undefined {
    return this.sessionDirectory;
  }

  async initialize(sessionId: string): Promise<void> {
    await ensurePrivateDirectory(this.rootDirectory);
    await this.cleanupDeadProcessDirectories();
    const sessionHash = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
    this.sessionDirectory = join(this.rootDirectory, `${sessionHash}-${process.pid}`);
    await ensurePrivateDirectory(this.sessionDirectory);
  }

  async createWriter(
    taskId: string,
    maxOutputBytes: number,
    maxTailBytes: number,
  ): Promise<BackgroundOutputWriter> {
    if (!this.sessionDirectory) throw new Error("Background output store is not initialized");
    return BackgroundOutputWriter.create(
      join(this.sessionDirectory, `${taskId}.log`),
      maxOutputBytes,
      maxTailBytes,
    );
  }

  async removeTaskFile(outputFile: string): Promise<void> {
    await rm(outputFile, { force: true });
  }

  async cleanup(): Promise<void> {
    const directory = this.sessionDirectory;
    this.sessionDirectory = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
  }

  private async cleanupDeadProcessDirectories(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.rootDirectory);
    } catch {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      const match = /-(\d+)$/u.exec(entry);
      if (!match) return;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return;
      try {
        process.kill(pid, 0);
      } catch (error) {
        const code = error instanceof Error && "code" in error ? String(error.code) : "";
        if (code === "EPERM") return;
        await rm(join(this.rootDirectory, entry), { recursive: true, force: true });
      }
    }));
  }
}
