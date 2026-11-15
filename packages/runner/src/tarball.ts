import { pipeline, Readable } from "node:stream";
import { createGunzip } from "node:zlib";

const BLOCK = 512;
// a pax or GNU long-name header is a path or a few; one past this is not a header
const MAX_HEADER_BODY = 1024 * 1024;
// a file past this is left to the caller's other way of fetching it, not held in memory
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
// GitHub's tree listing is cut off long before this many entries
const MAX_ENTRIES = 2_000_000;

const text = (buf: Buffer, start: number, length: number) => {
  const field = buf.subarray(start, start + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? length : end).toString("utf8");
};

/** `key=value` records of a pax header, each `<length> key=value\n`. */
function paxRecords(body: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let at = 0;
  while (at < body.length) {
    const space = body.indexOf(0x20, at);
    if (space === -1) break;
    const length = Number(body.subarray(at, space).toString());
    if (!Number.isInteger(length) || length <= space - at + 1) break;
    const record = body.subarray(space + 1, at + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq !== -1) records.set(record.slice(0, eq), record.slice(eq + 1));
    at += length;
  }
  return records;
}

/**
 * Bytes pulled from a chunked source exactly as asked: a count held, a count dropped. At most one
 * source chunk is kept between calls, so taking `n` bytes holds `n` plus that chunk.
 */
class Reader {
  /** The unread rest of the last chunk pulled; empty once it is used up. */
  private head: Buffer = Buffer.alloc(0);
  private readonly source: AsyncIterator<Buffer>;
  constructor(source: AsyncIterator<Buffer>) {
    this.source = source;
  }

  /** Pulls a chunk in when none is left unread; false at the end of the stream. */
  private async fill(): Promise<boolean> {
    while (this.head.length === 0) {
      const next = await this.source.next();
      if (next.done) return false;
      this.head = next.value;
    }
    return true;
  }

  /** Moves up to `n` bytes off the front, each run handed to `each` at its offset; the count moved. */
  private async consume(
    n: number,
    each?: (bytes: Buffer, at: number) => void,
  ): Promise<number> {
    let done = 0;
    while (done < n && (await this.fill())) {
      const cut = Math.min(n - done, this.head.length);
      each?.(this.head.subarray(0, cut), done);
      this.head = this.head.subarray(cut);
      done += cut;
    }
    return done;
  }

  /**
   * The next `n` bytes, or fewer at the end of the stream. Bytes within the chunk on hand come as a
   * view of it, which pins no more than that chunk; more are copied, as they arrive, into one buffer
   * of their own that nothing the reader keeps afterwards shares.
   */
  async take(n: number): Promise<Buffer> {
    if (n > 0 && !(await this.fill())) return Buffer.alloc(0);
    if (this.head.length >= n) {
      const out = this.head.subarray(0, n);
      this.head = this.head.subarray(n);
      return out;
    }
    const out = Buffer.allocUnsafe(n);
    const filled = await this.consume(n, (bytes, at) => bytes.copy(out, at));
    return filled === n ? out : out.subarray(0, filled);
  }

  /** Drops the next `n` bytes without holding them; the count dropped, which is fewer at the end. */
  skip(n: number): Promise<number> {
    return this.consume(n);
  }
}

/** Drops an entry's `padded` body; throws when the archive ends first. */
async function skipEntry(reader: Reader, padded: number): Promise<void> {
  if ((await reader.skip(padded)) < padded) {
    throw new Error("the archive ends inside an entry");
  }
}

/**
 * Walks a gzipped tar as it arrives: decompressed a chunk at a time, entries read in turn, and only
 * a file `wants` names is held, one at a time, so memory is the largest wanted file plus a few
 * buffers, never the archive. `file` runs, and is awaited, before the next entry is read, so a slow
 * consumer holds the download back. Paths come without the archive's top directory (GitHub wraps the
 * tree in `<owner>-<repo>-<sha>/`); a symlink's bytes are its target, as git stores it. Nothing is
 * written to disk, so no path in the archive can name a place on it. Stops reading at the end marker.
 */
export async function walkTarball(
  archive: AsyncIterable<Uint8Array>,
  entries: {
    wants: (path: string) => boolean;
    file: (path: string, bytes: Buffer) => Promise<void>;
  },
): Promise<void> {
  const inflated = pipeline(
    Readable.from(archive, { objectMode: false }),
    createGunzip(),
    () => {},
  );
  const reader = new Reader(
    inflated[Symbol.asyncIterator]() as AsyncIterator<Buffer>,
  );
  let pax = new Map<string, string>();
  let longName: string | undefined;
  let longLink: string | undefined;
  let count = 0;
  try {
    for (;;) {
      const header = await reader.take(BLOCK);
      if (header.length === 0) return;
      if (header.length < BLOCK) {
        throw new Error("the archive ends inside an entry");
      }
      if (header.every((byte) => byte === 0)) return;
      if (++count > MAX_ENTRIES) {
        throw new Error(`the archive holds more than ${MAX_ENTRIES} entries`);
      }
      const size = Number.parseInt(text(header, 124, 12).trim() || "0", 8);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error("the archive has an entry header that can't be read");
      }
      const type = String.fromCharCode(header[156] || 0x30);
      const padded = Math.ceil(size / BLOCK) * BLOCK;
      const named = type === "x" || type === "L" || type === "K";
      if (named || type === "g") {
        if (size > MAX_HEADER_BODY) {
          throw new Error("the archive has an entry header that is too large");
        }
        const body = await reader.take(padded);
        if (body.length < padded) {
          throw new Error("the archive ends inside an entry");
        }
        const content = body.subarray(0, size);
        if (type === "x") pax = paxRecords(content);
        else if (type === "L") longName = text(content, 0, size);
        else if (type === "K") longLink = text(content, 0, size);
        continue;
      }
      const prefix = text(header, 345, 155);
      const name =
        pax.get("path") ??
        longName ??
        (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
      const link = pax.get("linkpath") ?? longLink ?? text(header, 157, 100);
      pax = new Map();
      longName = undefined;
      longLink = undefined;
      const slash = name.indexOf("/");
      const path = slash === -1 ? "" : name.slice(slash + 1);
      const isFile = type === "0";
      const isLink = type === "2";
      if (!path || !(isFile || isLink) || !entries.wants(path)) {
        await skipEntry(reader, padded);
        continue;
      }
      if (isLink) {
        await skipEntry(reader, padded);
        await entries.file(path, Buffer.from(link));
        continue;
      }
      if (size > MAX_FILE_BYTES) {
        await skipEntry(reader, padded);
        continue;
      }
      const body = await reader.take(padded);
      if (body.length < padded) {
        throw new Error("the archive ends inside an entry");
      }
      await entries.file(path, body.subarray(0, size));
    }
  } finally {
    // the end marker or a failure stops the read; either way the download is cancelled
    inflated.destroy();
  }
}
