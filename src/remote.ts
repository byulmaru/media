import dns from "node:dns";

import { readBodyLimited } from "./body";
import { REMOTE_MAX_REDIRECTS, REMOTE_TIMEOUT_MS } from "./constants";
import { HttpError } from "./errors";

const blockedHostnames = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
]);
const blockedSuffixes = [
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
  ".test",
  ".example",
  ".invalid",
];

interface RemoteRuntime {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

const defaultRuntime: RemoteRuntime = {
  resolve4: dns.promises.resolve4.bind(dns.promises),
  resolve6: dns.promises.resolve6.bind(dns.promises),
  fetch: globalThis.fetch.bind(globalThis),
};
let runtime = defaultRuntime;

/** Test seam for workerd integration tests; production code never calls this. */
export function setRemoteRuntimeForTest(overrides?: Partial<RemoteRuntime>): void {
  runtime = overrides ? { ...defaultRuntime, ...overrides } : defaultRuntime;
}

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
}

export function validateRemoteUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "invalid_remote_url", "remote URL is invalid");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (url.port !== "" && url.port !== "443") ||
    hostname === "" ||
    !hostname.includes(".") ||
    isIpLiteral(hostname) ||
    blockedHostnames.has(hostname) ||
    blockedSuffixes.some((suffix) => hostname.endsWith(suffix))
  ) {
    throw new HttpError(400, "unsafe_remote_url", "remote URL must use a public HTTPS host");
  }
  url.hash = "";
  return url;
}

function isPublicIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [a, b, c] = octets as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function isPublicIpv6(address: string): boolean {
  const value = address.toLowerCase();
  if (value.startsWith("::ffff:")) return isPublicIpv4(value.slice("::ffff:".length));
  return !(
    value === "::" ||
    value === "::1" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    /^fe[89ab]/.test(value) ||
    value.startsWith("ff") ||
    value.startsWith("2001:db8:")
  );
}

async function assertPublicDns(hostname: string): Promise<void> {
  const results = await Promise.allSettled([
    runtime.resolve4(hostname),
    runtime.resolve6(hostname),
  ]);
  const addresses = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  if (addresses.length === 0) {
    throw new HttpError(502, "remote_dns_failed", "remote host did not resolve");
  }
  if (
    addresses.some((address) =>
      address.includes(":") ? !isPublicIpv6(address) : !isPublicIpv4(address),
    )
  ) {
    throw new HttpError(400, "unsafe_remote_url", "remote host resolves to a private or reserved address");
  }
}

function redirectLocation(response: Response, current: URL): URL {
  const location = response.headers.get("Location");
  if (!location) throw new HttpError(502, "invalid_remote_redirect", "redirect has no Location");
  return validateRemoteUrl(new URL(location, current).href);
}

export async function fetchRemoteImage(urlValue: string, maxBytes: number): Promise<ArrayBuffer> {
  let url = validateRemoteUrl(urlValue);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("remote timeout"), REMOTE_TIMEOUT_MS);
  try {
    for (let redirects = 0; redirects <= REMOTE_MAX_REDIRECTS; redirects += 1) {
      await assertPublicDns(url.hostname);
      let response: Response;
      try {
        response = await runtime.fetch(url, {
          redirect: "manual",
          signal: controller.signal,
          headers: { Accept: "image/jpeg, image/png, image/webp" },
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new HttpError(504, "remote_timeout", "remote image request timed out");
        }
        throw new HttpError(
          502,
          "remote_fetch_failed",
          error instanceof Error ? `remote fetch failed: ${error.message}` : "remote fetch failed",
        );
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects === REMOTE_MAX_REDIRECTS) {
          throw new HttpError(502, "too_many_redirects", "remote image redirected too many times");
        }
        await response.body?.cancel();
        url = redirectLocation(response, url);
        continue;
      }
      if (!response.ok) {
        throw new HttpError(502, "remote_fetch_failed", `remote server returned ${response.status}`);
      }
      return await readBodyLimited(response, maxBytes);
    }
    throw new HttpError(502, "too_many_redirects", "remote image redirected too many times");
  } finally {
    clearTimeout(timeout);
  }
}
