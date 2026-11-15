// Compile-time check of the proxy types (not run): npx tsc --noEmit --strict --skipLibCheck --module nodenext --moduleResolution nodenext test/types-check.ts
import type { CreateTaskOptions, Proxy } from "../dist/index.js";

export const own: Proxy = { type: "socks5", host: "gw.example.net", port: 1080, username: "u", password: "p" };
export const net: Proxy = { network: "residential", country: "gb" };
export const netOnly: Proxy = { network: "datacenter" };
export const task: CreateTaskOptions = { task: "x", proxy: { network: "datacenter", country: "us" } };

// @ts-expect-error a network takes no host next to it
export const mixed: Proxy = { network: "datacenter", host: "gw.example.net" };
// @ts-expect-error a network takes no password next to it
export const mixed2: Proxy = { network: "residential", password: "p" };
// @ts-expect-error only the two tiers are networks
export const unknownTier: Proxy = { network: "mobile" };
