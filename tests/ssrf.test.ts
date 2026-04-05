import { describe, it, expect } from "vitest";
import {
  validateUrl,
  buildBaseUrlPolicy,
  isBlockedHostname,
  isPrivateIpAddress,
  SsrFBlockedError,
} from "../src/memory/ssrf.js";

describe("buildBaseUrlPolicy", () => {
  it("extracts hostname from URL", () => {
    const policy = buildBaseUrlPolicy("https://api.openai.com/v1");
    expect(policy).toBeDefined();
    expect(policy!.allowedHostnames).toEqual(["api.openai.com"]);
  });

  it("returns undefined for non-HTTP", () => {
    expect(buildBaseUrlPolicy("ftp://example.com")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(buildBaseUrlPolicy("")).toBeUndefined();
  });
});

describe("isBlockedHostname", () => {
  it("blocks localhost", () => {
    expect(isBlockedHostname("localhost")).toBe(true);
    expect(isBlockedHostname("localhost.localdomain")).toBe(true);
  });

  it("blocks .local and .internal", () => {
    expect(isBlockedHostname("myhost.local")).toBe(true);
    expect(isBlockedHostname("metadata.google.internal")).toBe(true);
  });

  it("allows public hostnames", () => {
    expect(isBlockedHostname("api.openai.com")).toBe(false);
    expect(isBlockedHostname("example.com")).toBe(false);
  });
});

describe("isPrivateIpAddress", () => {
  it("blocks RFC 1918 ranges", () => {
    expect(isPrivateIpAddress("10.0.0.1")).toBe(true);
    expect(isPrivateIpAddress("172.16.0.1")).toBe(true);
    expect(isPrivateIpAddress("192.168.1.1")).toBe(true);
  });

  it("blocks loopback", () => {
    expect(isPrivateIpAddress("127.0.0.1")).toBe(true);
    expect(isPrivateIpAddress("::1")).toBe(true);
  });

  it("blocks link-local", () => {
    expect(isPrivateIpAddress("169.254.1.1")).toBe(true);
    expect(isPrivateIpAddress("fe80::1")).toBe(true);
  });

  it("allows public IPs", () => {
    expect(isPrivateIpAddress("8.8.8.8")).toBe(false);
    expect(isPrivateIpAddress("1.1.1.1")).toBe(false);
  });

  it("strips brackets from IPv6", () => {
    expect(isPrivateIpAddress("[::1]")).toBe(true);
  });
});

describe("validateUrl", () => {
  it("allows HTTPS URLs", async () => {
    const result = await validateUrl("https://api.openai.com/v1/embeddings");
    expect(result).toBeDefined();
    expect(result.resolvedAddresses.length).toBeGreaterThan(0);
  });

  it("blocks non-HTTP protocols", async () => {
    await expect(validateUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(validateUrl("ftp://example.com")).rejects.toThrow();
  });

  it("blocks private IPs", async () => {
    await expect(validateUrl("http://127.0.0.1/api")).rejects.toThrow();
    await expect(validateUrl("http://10.0.0.1/api")).rejects.toThrow();
    await expect(validateUrl("http://192.168.1.1/api")).rejects.toThrow();
  });

  it("blocks localhost", async () => {
    await expect(validateUrl("http://localhost/api")).rejects.toThrow();
  });

  it("blocks IPv6 loopback", async () => {
    await expect(validateUrl("http://[::1]/api")).rejects.toThrow();
  });

  it("enforces hostname allowlist", async () => {
    const policy = buildBaseUrlPolicy("https://api.openai.com/v1")!;
    const result = await validateUrl("https://api.openai.com/v1/embed", policy);
    expect(result).toBeDefined();
    await expect(validateUrl("https://evil.com/steal", policy)).rejects.toThrow("not in allowlist");
  });

  it("SsrFBlockedError has correct name", () => {
    const err = new SsrFBlockedError("test");
    expect(err.name).toBe("SsrFBlockedError");
    expect(err instanceof Error).toBe(true);
  });
});
