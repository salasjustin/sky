import { lookup as dnsLookup, type LookupOptions } from "node:dns";
import { BlockList, isIPv4, isIPv6 } from "node:net";
import { Agent } from "undici";

// addresses a subscriber URL may not name: loopback, unspecified, private, shared, link-local,
// unique-local (fc00::/7 holds Fly's 6PN fdaa::/16), IETF protocol, benchmarking, multicast, reserved
const internal = new BlockList();
internal.addSubnet("0.0.0.0", 8, "ipv4");
internal.addSubnet("10.0.0.0", 8, "ipv4");
internal.addSubnet("100.64.0.0", 10, "ipv4");
internal.addSubnet("127.0.0.0", 8, "ipv4");
internal.addSubnet("169.254.0.0", 16, "ipv4");
internal.addSubnet("172.16.0.0", 12, "ipv4");
internal.addSubnet("192.0.0.0", 24, "ipv4");
internal.addSubnet("192.168.0.0", 16, "ipv4");
internal.addSubnet("198.18.0.0", 15, "ipv4");
internal.addSubnet("224.0.0.0", 4, "ipv4");
internal.addSubnet("240.0.0.0", 4, "ipv4");
// IPv4-compatible ::/96 (which holds :: and ::1), discard, Teredo, benchmarking, documentation, 6to4,
// local-use NAT64
internal.addSubnet("::", 96, "ipv6");
internal.addSubnet("100::", 64, "ipv6");
internal.addSubnet("2001::", 32, "ipv6");
internal.addSubnet("2001:2::", 48, "ipv6");
internal.addSubnet("2001:db8::", 32, "ipv6");
internal.addSubnet("2002::", 16, "ipv6");
internal.addSubnet("64:ff9b:1::", 48, "ipv6");
internal.addSubnet("fc00::", 7, "ipv6");
internal.addSubnet("fe80::", 10, "ipv6");
internal.addSubnet("ff00::", 8, "ipv6");

const internalSuffixes = [
  ".localhost",
  ".internal",
  ".flycast",
  ".local",
  ".home.arpa",
];

/** The IPv4 address a NAT64 `64:ff9b::/96` address embeds, as dotted text; null for any other address. */
function nat64Embedded(address: string): string | null {
  const m =
    /^64:ff9b::(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i.exec(
      address,
    );
  if (!m) return null;
  if (m[3]) return m[3];
  const hi = Number.parseInt(m[1] as string, 16);
  const lo = Number.parseInt(m[2] as string, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

/** Whether a literal IPv4 or IPv6 address (no brackets) is one a webhook may not reach. */
export function isInternalAddress(address: string): boolean {
  if (isIPv4(address)) return internal.check(address, "ipv4");
  // a zone id ("fe80::1%eth0") is link-local by nature, and URL can't parse it
  if (!isIPv6(address) || address.includes("%")) return true;
  // the parser may hand back any spelling; normalize through URL so "64:ff9b::7f00:1" matches
  let canonical: string;
  try {
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return true;
  }
  const embedded = nat64Embedded(canonical);
  if (embedded) return isInternalAddress(embedded);
  if (canonical.toLowerCase().startsWith("64:ff9b::")) return true;
  // ::ffff:0:0/96 is refused whole; a BlockList entry for it would also match every IPv4 address
  if (canonical.toLowerCase().startsWith("::ffff:")) return true;
  return internal.check(canonical, "ipv6");
}

/**
 * Whether a subscriber URL's host is a public name or address: not `localhost`, not a name under
 * `.internal`, `.flycast`, `.local` or `.home.arpa`, not a single-label name, and not a literal
 * internal IP. Checks the WHATWG-parsed host, which canonicalizes hex, octal and dword IPv4 spellings.
 * A URL carrying a username or password is refused.
 * A public-looking name that resolves to an internal address is refused at connect time, by
 * `guardedLookup`.
 */
export function isAllowedWebhookUrl(url: string): boolean {
  return refusalOf(url) === null;
}

/**
 * Why a stored or submitted URL is refused: `url_not_allowed` for its form (not https, a port, a
 * username or password, unparseable) and `blocked_address` for the host it names; null when allowed.
 */
export function refusalOf(url: string): RefusalKind | null {
  let hostname: string;
  try {
    const parsed = new URL(url);
    // https on the default port only; the WHATWG parser drops an explicit :443
    if (parsed.protocol !== "https:" || parsed.port !== "") {
      return "url_not_allowed";
    }
    if (parsed.username !== "" || parsed.password !== "") {
      return "url_not_allowed";
    }
    hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "url_not_allowed";
  }
  const blocked = (refused: boolean) => (refused ? "blocked_address" : null);
  if (hostname === "localhost") return "blocked_address";
  if (isIPv4(hostname)) return blocked(isInternalAddress(hostname));
  const bare = hostname.replace(/^\[|\]$/g, "");
  if (isIPv6(bare)) return blocked(isInternalAddress(bare));
  if (!hostname.includes(".")) return "blocked_address";
  return blocked(internalSuffixes.some((s) => hostname.endsWith(s)));
}

export type RefusalKind = "url_not_allowed" | "blocked_address";

/** Thrown by the connect-time and stored-URL checks; its text is the kind alone, naming no address, host or port. */
export class BlockedAddressError extends Error {
  constructor(readonly kind: RefusalKind = "blocked_address") {
    super(kind);
    this.name = "BlockedAddressError";
  }
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | { address: string; family: number }[],
  family?: number,
) => void;
export type LookupFn = (
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
) => void;

/**
 * A `lookup` for a socket's connect: resolves every address of the host with `resolve` and refuses
 * the connection when any of them is internal, so the address checked is the one connected to.
 */
export function guardedLookup(resolve: LookupFn = dnsLookup as LookupFn) {
  return (
    hostname: string,
    options: LookupOptions,
    callback: LookupCallback,
  ): void => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 0);
      const list = Array.isArray(addresses)
        ? addresses
        : [{ address: addresses, family: isIPv6(addresses) ? 6 : 4 }];
      if (list.length === 0 || list.some((a) => isInternalAddress(a.address))) {
        return callback(new BlockedAddressError(), "", 0);
      }
      if (options.all) return callback(null, list);
      const first = list[0] as { address: string; family: number };
      callback(null, first.address, first.family);
    });
  };
}

/** An undici agent whose every connection goes through `guardedLookup`. */
export function guardedAgent(resolve?: LookupFn): Agent {
  return new Agent({
    pipelining: 0,
    connect: { lookup: guardedLookup(resolve) },
  });
}

const placeholder = "<addr>";

/**
 * Error text with IPv4 and IPv6 addresses, and `host:port` pairs, replaced by a placeholder, so a
 * reader learns the kind of failure and nothing about the network.
 */
export function scrubAddresses(text: string): string {
  return text
    .replace(/\[[0-9a-f:.]*:[0-9a-f:.]*\](?::\d+)?/gi, placeholder)
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?/g, placeholder)
    .replace(
      /(?<![0-9a-z:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![0-9a-z:])/gi,
      placeholder,
    )
    .replace(
      /\b[a-z0-9]([a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*:\d{1,5}\b/gi,
      placeholder,
    );
}
