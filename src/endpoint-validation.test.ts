/**
 * Security regression (audit C4): the OTel exporter endpoint must require
 * `https:` for a non-loopback collector (GenAI spans carry pre-masked model
 * input/output and must not travel in plaintext to a remote host), must reject
 * credentials embedded in the URL, and its validation error must name the config
 * key WITHOUT ever echoing the URL or its userinfo.
 */
import { describe, it, expect, vi } from "vitest";
import { resolveConfig, validateEndpoint, register } from "./index.js";

describe("C4 — OTel endpoint validation", () => {
  it("allows loopback http and any https", () => {
    expect(() => validateEndpoint("http://localhost:4318", "k")).not.toThrow();
    expect(() => validateEndpoint("http://127.0.0.1:4318", "k")).not.toThrow();
    expect(() => validateEndpoint("http://[::1]:4318", "k")).not.toThrow();
    expect(() => validateEndpoint("https://collector.example.com", "k")).not.toThrow();
    // The §6 default (loopback http) is accepted.
    expect(() => resolveConfig()).not.toThrow();
  });

  it("rejects plaintext http to a non-loopback host", () => {
    expect(() => validateEndpoint("http://collector.example.com:4318", "otelExporter.endpoint")).toThrow(
      /otelExporter\.endpoint must use https/,
    );
  });

  it("rejects credentials in the URL without echoing the userinfo", () => {
    const url = "https://user:sup3rsecret@collector.example.com";
    try {
      validateEndpoint(url, "otelExporter.endpoint");
      throw new Error("expected validateEndpoint to throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("otelExporter.endpoint");
      // The secret and the URL never appear in the error.
      expect(msg).not.toContain("sup3rsecret");
      expect(msg).not.toContain("user:");
      expect(msg).not.toContain("collector.example.com");
    }
  });

  it("register degrades to a logged warning (no throw) on a bad endpoint", () => {
    const exporter = vi.fn();
    // register must not throw; a config failure logs and registers nothing (§7).
    expect(() =>
      register({ register: { exporter } }, { config: { endpoint: "http://remote:4318" } }),
    ).not.toThrow();
    expect(exporter).not.toHaveBeenCalled();
  });

  it("refuses a cloud-metadata endpoint via core.network.isMetadataHost, naming the host", () => {
    const isMeta = (h: string) => h === "169.254.169.254" || h === "metadata.google.internal";
    // validateEndpoint throws, naming the host, never echoing scheme/path.
    try {
      validateEndpoint("https://169.254.169.254/v1/traces", "otelExporter.endpoint", isMeta);
      throw new Error("expected throw");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("cloud instance-metadata");
      expect(msg).toContain("169.254.169.254");
      expect(msg).not.toContain("https://");
      expect(msg).not.toContain("/v1/traces");
    }
    // The DNS metadata name is refused too (even though https).
    expect(() => validateEndpoint("https://metadata.google.internal", "k", isMeta)).toThrow(/metadata/);
  });

  it("register does not register the exporter for a metadata endpoint (plugin disabled)", () => {
    const exporter = vi.fn();
    const core = {
      register: { exporter },
      network: { isMetadataHost: (h: string) => h === "169.254.169.254" },
    };
    expect(() => register(core, { config: { endpoint: "https://169.254.169.254" } })).not.toThrow();
    expect(exporter).not.toHaveBeenCalled();
  });
});
