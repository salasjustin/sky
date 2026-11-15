import { gunzipSync } from "node:zlib";

const BLOCK = 512;

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
 * The files of a gzipped tar as bytes, by path with the archive's top directory removed: GitHub's
 * tarball wraps the tree in `<owner>-<repo>-<sha>/`. A symlink's bytes are its target, as git stores
 * it. Read in memory, never written out, so nothing in the archive can name a place on disk.
 */
export function readTarball(archive: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(archive);
  const files = new Map<string, Buffer>();
  let at = 0;
  let pax = new Map<string, string>();
  let longName: string | undefined;
  let longLink: string | undefined;
  while (at + BLOCK <= tar.length) {
    const header = tar.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = Number.parseInt(text(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 0x30);
    const bodyAt = at + BLOCK;
    const body = tar.subarray(bodyAt, bodyAt + size);
    at = bodyAt + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      pax = paxRecords(body);
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      longName = text(body, 0, body.length);
      continue;
    }
    if (type === "K") {
      longLink = text(body, 0, body.length);
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
    if (!path) continue;
    if (type === "0") files.set(path, Buffer.from(body));
    else if (type === "2") files.set(path, Buffer.from(link));
  }
  return files;
}
