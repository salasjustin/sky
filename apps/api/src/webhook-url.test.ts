import { expect, test } from "vitest";
import {
  BlockedAddressError,
  guardedLookup,
  isAllowedWebhookUrl,
  isInternalAddress,
  type LookupFn,
  refusalOf,
  scrubAddresses,
} from "./webhook-url.js";

test.each([
  ["localhost", "https://localhost/hook"],
  ["localhost with a port and odd case", "http://LocalHost:8080/hook"],
  ["localhost as an FQDN", "https://localhost./hook"],
  ["a localhost subdomain", "https://api.localhost/hook"],
  ["IPv4 loopback", "https://127.0.0.1/hook"],
  ["IPv4 loopback anywhere in 127/8", "https://127.8.9.10/hook"],
  ["IPv4 loopback in hex shorthand", "https://0x7f.1/hook"],
  ["IPv4 loopback as a dword", "https://2130706433/hook"],
  ["the unspecified IPv4 address", "https://0.0.0.0/hook"],
  ["10/8", "https://10.1.2.3/hook"],
  ["172.16/12, low end", "https://172.16.0.1/hook"],
  ["172.16/12, high end", "https://172.31.255.255/hook"],
  ["192.168/16", "https://192.168.1.1/hook"],
  ["100.64/10 (shared address space)", "https://100.64.0.1/hook"],
  ["link-local / cloud metadata", "https://169.254.169.254/latest/meta-data"],
  ["IPv6 loopback", "https://[::1]/hook"],
  ["the unspecified IPv6 address", "https://[::]/hook"],
  ["IPv6 link-local", "https://[fe80::1]/hook"],
  ["IPv6 unique-local fc00::/7, fc half", "https://[fc00::1]/hook"],
  ["IPv6 unique-local fc00::/7, fd half", "https://[fd12:3456::1]/hook"],
  ["IPv4-mapped IPv6 loopback", "https://[::ffff:127.0.0.1]/hook"],
  ["IPv4-mapped IPv6 private", "https://[::ffff:10.0.0.1]/hook"],
  ["an unparseable URL", "not a url"],
  ["a .internal name", "https://sky-api.internal/hook"],
  ["Fly's internal API name", "https://_api.internal/hook"],
  ["a .flycast name", "https://my-app.flycast/hook"],
  ["a .local name", "https://printer.local/hook"],
  ["a .home.arpa name", "https://nas.home.arpa/hook"],
  ["a single-label host", "https://intranet/hook"],
  ["a .internal name as an FQDN", "https://sky-api.internal./hook"],
  ["192.0.0.0/24", "https://192.0.0.8/hook"],
  ["198.18.0.0/15, low end", "https://198.18.0.1/hook"],
  ["198.18.0.0/15, high end", "https://198.19.255.254/hook"],
  ["multicast 224.0.0.0/4", "https://224.0.0.1/hook"],
  ["reserved 240.0.0.0/4", "https://240.0.0.1/hook"],
  ["IPv6 multicast", "https://[ff02::1]/hook"],
  ["Fly's 6PN fdaa::/16", "https://[fdaa:0:1234::3]/hook"],
  ["NAT64 embedding loopback", "https://[64:ff9b::7f00:1]/hook"],
  ["NAT64 embedding 10/8, dotted", "https://[64:ff9b::10.0.0.1]/hook"],
  [
    "a 64:ff9b::/96 address that embeds no IPv4",
    "https://[64:ff9b::1:2:3]/hook",
  ],
  ["IPv4-mapped IPv6 public", "https://[::ffff:8.8.8.8]/hook"],
  ["IPv4-compatible ::/96, loopback", "https://[::7f00:1]/hook"],
  ["IPv4-compatible ::/96, public IPv4", "https://[::808:808]/hook"],
  ["6to4 2002::/16", "https://[2002:808:808::1]/hook"],
  ["Teredo 2001::/32", "https://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/hook"],
  ["local-use NAT64 64:ff9b:1::/48", "https://[64:ff9b:1::808:808]/hook"],
  ["discard 100::/64", "https://[100::1]/hook"],
  ["documentation 2001:db8::/32", "https://[2001:db8::1]/hook"],
  ["an IPv6 literal with a zone id", "https://[fe80::1%25eth0]/hook"],
  ["a plain-http URL", "http://hooks.example.com/hook"],
  ["a non-default port", "https://hooks.example.com:8443/hook"],
  ["Fly's internal API port", "https://hooks.example.com:4280/hook"],
  ["a username and password", "https://user:pass@hooks.example.com/hook"],
  ["a public-looking username", "https://hooks.example.com@10.0.0.1/hook"],
])("rejects %s", (_, url) => {
  expect(isAllowedWebhookUrl(url)).toBe(false);
});

test("allows an explicit default port", () => {
  expect(isAllowedWebhookUrl("https://hooks.example.com:443/hook")).toBe(true);
});

const resolvesTo =
  (...addresses: string[]): LookupFn =>
  (_host, _options, callback) =>
    callback(
      null,
      addresses.map((address) => ({
        address,
        family: address.includes(":") ? 6 : 4,
      })),
    );

const lookupOf = (resolve: LookupFn, all = false) =>
  new Promise<{ err: Error | null; address: unknown }>((done) =>
    guardedLookup(resolve)("hooks.example.com", { all }, (err, address) =>
      done({ err, address }),
    ),
  );

test.each([
  ["IPv4 private", ["10.0.0.5"]],
  ["a 6PN address", ["fdaa:0:1::3"]],
  ["one internal among public addresses", ["8.8.8.8", "10.0.0.5"]],
  ["IPv6 loopback", ["::1"]],
  ["a NAT64-embedded private address", ["64:ff9b::a00:1"]],
  ["an IPv4-compatible address", ["::7f00:1"]],
  ["a 6to4 address", ["2002:808:808::1"]],
  ["a Teredo address", ["2001:0:4136:e378:8000:63bf:3fff:fdd2"]],
  ["a local-use NAT64 address", ["64:ff9b:1::808:808"]],
  ["a discard-prefix address", ["100::1"]],
  ["a documentation address", ["2001:db8::1"]],
  ["an address with a zone id", ["fe80::1%eth0"]],
  ["a public address followed by one with a zone id", ["8.8.8.8", "::1%lo"]],
])("the connect-time lookup refuses %s", async (_, addresses) => {
  const { err } = await lookupOf(resolvesTo(...addresses));
  expect(err).toBeInstanceOf(BlockedAddressError);
  expect(err?.message).toBe("blocked_address");
});

test("an address with a zone id is refused, not thrown on", () => {
  expect(isInternalAddress("fe80::1%eth0")).toBe(true);
  expect(isInternalAddress("2606:4700:4700::1111%eth0")).toBe(true);
});

test("a stored URL is refused as url_not_allowed for its form and blocked_address for its host", () => {
  expect(refusalOf("https://hooks.example.com/hook")).toBeNull();
  expect(refusalOf("https://hooks.example.com:8443/hook")).toBe(
    "url_not_allowed",
  );
  expect(refusalOf("http://hooks.example.com/hook")).toBe("url_not_allowed");
  expect(refusalOf("https://user:pw@hooks.example.com/hook")).toBe(
    "url_not_allowed",
  );
  expect(refusalOf("not a url")).toBe("url_not_allowed");
  expect(refusalOf("https://sky-api.internal/hook")).toBe("blocked_address");
  expect(refusalOf("https://10.0.0.5/hook")).toBe("blocked_address");
});

test("the connect-time lookup passes public addresses through", async () => {
  expect(await lookupOf(resolvesTo("8.8.8.8"))).toEqual({
    err: null,
    address: "8.8.8.8",
  });
  const all = await lookupOf(
    resolvesTo("8.8.8.8", "2606:4700:4700::1111"),
    true,
  );
  expect(all.address).toHaveLength(2);
});

test("the connect-time lookup resolves again on every connect", async () => {
  const answers = ["8.8.8.8", "10.0.0.5"];
  const resolve: LookupFn = (host, options, callback) =>
    resolvesTo(answers.shift() as string)(host, options, callback);
  const lookup = guardedLookup(resolve);
  const connect = () =>
    new Promise<Error | null>((done) =>
      lookup("hooks.example.com", {}, (err) => done(err)),
    );
  expect(await connect()).toBeNull();
  expect(await connect()).toBeInstanceOf(BlockedAddressError);
});

test("the connect-time lookup asks the resolver for every address", async () => {
  const received: unknown[] = [];
  const resolve: LookupFn = (host, options, callback) => {
    received.push(options);
    resolvesTo("8.8.8.8")(host, options, callback);
  };
  await lookupOf(resolve, false);
  expect(received).toEqual([{ all: true }]);
});

const resolvesToString =
  (address: string, family: number): LookupFn =>
  (_host, _options, callback) =>
    callback(null, address, family);

test("the connect-time lookup refuses a resolver's single internal string address", async () => {
  const { err } = await lookupOf(resolvesToString("10.0.0.5", 4));
  expect(err).toBeInstanceOf(BlockedAddressError);
});

test("the connect-time lookup passes a resolver's single public string address through", async () => {
  expect(await lookupOf(resolvesToString("8.8.8.8", 4))).toEqual({
    err: null,
    address: "8.8.8.8",
  });
});

test("the connect-time lookup refuses an empty address list", async () => {
  const { err } = await lookupOf(resolvesTo());
  expect(err).toBeInstanceOf(BlockedAddressError);
});

test("the connect-time lookup passes a resolver's error through", async () => {
  const failure = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
    code: "ENOTFOUND",
  });
  const { err } = await lookupOf((_host, _options, callback) =>
    callback(failure, "", 0),
  );
  expect(err).toBe(failure);
});

test.each([
  [
    "fetch failed: connect ECONNREFUSED 203.0.113.9:443",
    "fetch failed: connect ECONNREFUSED <addr>",
  ],
  [
    "connect ETIMEDOUT 10.1.2.3:8080 and 10.1.2.4",
    "connect ETIMEDOUT <addr> and <addr>",
  ],
  ["connect ECONNREFUSED ::1:443", "connect ECONNREFUSED <addr>"],
  ["connect ECONNREFUSED [fdaa:0:1::3]:443", "connect ECONNREFUSED <addr>"],
  ["connect EHOSTUNREACH 2606:4700:4700::1111", "connect EHOSTUNREACH <addr>"],
  ["getaddrinfo failed for db.internal:5432", "getaddrinfo failed for <addr>"],
  ["timed out after 30s", "timed out after 30s"],
])("scrubbing %j", (text, scrubbed) => {
  expect(scrubAddresses(text)).toBe(scrubbed);
});

test.each([
  ["a public hostname", "https://hooks.example.com/sky"],
  ["a public IPv4", "https://8.8.8.8/hook"],
  ["an address just outside 172.16/12", "https://172.32.0.1/hook"],
  ["an address just outside 100.64/10", "https://100.128.0.1/hook"],
  ["a public IPv6", "https://[2606:4700:4700::1111]/hook"],
  [
    "a public IPv6 just outside 2001::/32",
    "https://[2001:4860:4860::8888]/hook",
  ],
  [
    "a NAT64 address embedding a public IPv4",
    "https://[64:ff9b::808:808]/hook",
  ],
  [
    "a hostname that merely contains localhost",
    "https://localhost.example.com/hook",
  ],
])("allows %s", (_, url) => {
  expect(isAllowedWebhookUrl(url)).toBe(true);
});
