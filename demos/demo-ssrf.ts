/**
 * Demo: SSRF protection for embedding provider HTTP calls
 *
 * Shows:
 * - Private IP blocking (RFC 1918, loopback, link-local, CGN, etc.)
 * - Blocked hostnames (localhost, *.local, *.internal, metadata.google.internal)
 * - Hostname allowlist enforcement
 * - Non-HTTP protocol blocking
 * - Legacy/malformed IPv4 literal blocking
 * - IPv6 loopback and ULA blocking
 * - URL policy creation from base URL
 *
 * Run: npx tsx demos/demo-ssrf.ts
 * Note: No API key needed — runs entirely locally.
 */
import {
  validateUrl,
  buildBaseUrlPolicy,
  isBlockedHostname,
  isPrivateIpAddress,
  isBlockedHostnameOrIp,
  SsrFBlockedError,
} from "../src/memory/ssrf.js";

async function tryValidate(label: string, url: string, policy?: ReturnType<typeof buildBaseUrlPolicy>) {
  try {
    await validateUrl(url, policy ?? undefined);
    console.log(`  ✓ ALLOWED  ${label}`);
  } catch (err) {
    const msg = err instanceof SsrFBlockedError ? err.message : (err as Error).message;
    console.log(`  ✗ BLOCKED  ${label} — ${msg.slice(0, 60)}`);
  }
}

async function main() {
  console.log("=== SSRF Protection Demo ===\n");

  // --- Private IP ranges ---
  console.log("--- Private IP detection ---\n");
  const ips = [
    { ip: "10.0.0.1", expected: true, label: "RFC 1918 (10/8)" },
    { ip: "172.16.0.1", expected: true, label: "RFC 1918 (172.16/12)" },
    { ip: "192.168.1.1", expected: true, label: "RFC 1918 (192.168/16)" },
    { ip: "127.0.0.1", expected: true, label: "Loopback" },
    { ip: "169.254.1.1", expected: true, label: "Link-local" },
    { ip: "100.64.0.1", expected: true, label: "CGN (100.64/10)" },
    { ip: "192.0.2.1", expected: true, label: "TEST-NET-1" },
    { ip: "198.18.0.1", expected: true, label: "Benchmark (198.18/15)" },
    { ip: "224.0.0.1", expected: true, label: "Multicast" },
    { ip: "0.0.0.0", expected: true, label: "This network" },
    { ip: "::1", expected: true, label: "IPv6 loopback" },
    { ip: "fe80::1", expected: true, label: "IPv6 link-local" },
    { ip: "fc00::1", expected: true, label: "IPv6 ULA" },
    { ip: "8.8.8.8", expected: false, label: "Google DNS (public)" },
    { ip: "1.1.1.1", expected: false, label: "Cloudflare (public)" },
    { ip: "104.18.0.1", expected: false, label: "CDN IP (public)" },
  ];

  for (const { ip, expected, label } of ips) {
    const result = isPrivateIpAddress(ip);
    const status = result === expected ? "✓" : "✗";
    console.log(`  ${status} ${ip.padEnd(18)} ${(result ? "PRIVATE" : "PUBLIC").padEnd(8)} ${label}`);
  }

  // --- Blocked hostnames ---
  console.log("\n--- Blocked hostnames ---\n");
  const hostnames = [
    { host: "localhost", expected: true },
    { host: "localhost.localdomain", expected: true },
    { host: "metadata.google.internal", expected: true },
    { host: "myapp.local", expected: true },
    { host: "test.internal", expected: true },
    { host: "service.localhost", expected: true },
    { host: "api.openai.com", expected: false },
    { host: "example.com", expected: false },
  ];

  for (const { host, expected } of hostnames) {
    const result = isBlockedHostname(host);
    const status = result === expected ? "✓" : "✗";
    console.log(`  ${status} ${host.padEnd(30)} ${result ? "BLOCKED" : "ALLOWED"}`);
  }

  // --- URL validation ---
  console.log("\n--- URL validation ---\n");
  await tryValidate("Public HTTPS API", "https://api.openai.com/v1/embeddings");
  await tryValidate("Public HTTP", "http://example.com/api");
  await tryValidate("Localhost", "http://localhost/api");
  await tryValidate("Private IP", "http://10.0.0.1/internal");
  await tryValidate("Loopback", "http://127.0.0.1:8080/api");
  await tryValidate("IPv6 loopback", "http://[::1]/api");
  await tryValidate("Link-local", "http://169.254.169.254/metadata");
  await tryValidate("Cloud metadata", "http://metadata.google.internal/computeMetadata");
  await tryValidate("FTP protocol", "ftp://files.example.com/data");
  await tryValidate("File protocol", "file:///etc/passwd");

  // --- Hostname allowlist ---
  console.log("\n--- Hostname allowlist (policy) ---\n");
  const policy = buildBaseUrlPolicy("https://api.openai.com/v1")!;
  console.log(`  Policy: allowedHostnames=${JSON.stringify(policy.allowedHostnames)}\n`);
  await tryValidate("Same host", "https://api.openai.com/v1/embeddings", policy);
  await tryValidate("Different host", "https://evil.com/steal-tokens", policy);
  await tryValidate("Subdomain", "https://api2.openai.com/v1/chat", policy);

  // --- Combined hostname+IP check ---
  console.log("\n--- Combined isBlockedHostnameOrIp ---\n");
  const combined = [
    "localhost", "127.0.0.1", "metadata.google.internal",
    "10.0.0.1", "::1", "api.openai.com",
  ];
  for (const target of combined) {
    const result = isBlockedHostnameOrIp(target);
    console.log(`  ${target.padEnd(30)} ${result ? "BLOCKED" : "ALLOWED"}`);
  }

  console.log("\nDemo complete.");
}

main().catch(console.error);
