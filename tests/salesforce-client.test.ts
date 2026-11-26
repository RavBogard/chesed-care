import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildJwtAssertion, createSalesforceClient, SalesforceError } from "@/server/salesforce/client";
import { assertAccountId, assertContactId, assertSfId, soqlId } from "@/server/salesforce/ids";
import { assertReadOnlySoql, RefusedQuery } from "@/server/salesforce/soql-guard";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const config = { consumerKey: "ck", username: "svc@crc.test", privateKey: Buffer.from(pem).toString("base64"), audience: "https://login.example.test" };

type Call = { url: string; init: RequestInit };

function fakeFetch(responses: Array<(call: Call) => Response>) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next(call);
  }) as typeof fetch;
  return { fn, calls };
}

const tokenOk = () => Response.json({ access_token: "tok", instance_url: "https://crc.my.example.test" });

describe("SOQL guard", () => {
  it("allows a single SELECT, including literals that contain keywords and semicolons", () => {
    expect(assertReadOnlySoql("  SELECT Id FROM Contact WHERE Name = 'a; DELETE FOR UPDATE'  ")).toBe("SELECT Id FROM Contact WHERE Name = 'a; DELETE FOR UPDATE'");
    expect(assertReadOnlySoql("select Id from Account where Name = 'O\\'Brien'")).toBeTruthy();
  });

  it.each([
    ["DELETE FROM Contact"],
    ["UPDATE Contact SET Name = 'x'"],
    ["INSERT INTO Contact"],
    ["upsert Contact"],
    ["SELECT Id FROM Contact; SELECT Id FROM Account"],
    ["SELECT Id FROM Contact FOR UPDATE"],
    ["SELECT Id FROM Contact LIMIT 1 FOR VIEW"],
    ["SELECT Id FROM Contact FOR REFERENCE"],
    ["SELECT Id FROM KnowledgeArticleVersion UPDATE TRACKING"],
    ["SELECT Id FROM KnowledgeArticleVersion UPDATE VIEWSTAT"],
    ["FIND {x} RETURNING Contact"],
    ["SELECT Id FROM Contact WHERE Name = 'unterminated"],
    [""],
    ["SELECTId FROM Contact"],
  ])("refuses %j", (soql) => {
    expect(() => assertReadOnlySoql(soql)).toThrow(RefusedQuery);
  });

  it("refuses non-strings", () => {
    expect(() => assertReadOnlySoql(undefined)).toThrow(RefusedQuery);
  });
});

describe("Salesforce ids", () => {
  it("accepts 15 and 18 character ids and checks Contact / Account prefixes", () => {
    expect(assertSfId("a0B000000000001")).toBe("a0B000000000001");
    expect(assertContactId("003000000000001AAA")).toBe("003000000000001AAA");
    expect(assertAccountId("001000000000001AAA")).toBe("001000000000001AAA");
    expect(soqlId("001000000000001AAA")).toBe("'001000000000001AAA'");
  });

  it.each(["", "003", "003000000000001AA", "003000000000001AAA'", "' OR Id != '", "003000000000001AAA OR", null, 42])("rejects %j", (v) => {
    expect(() => assertSfId(v)).toThrow();
  });

  it("rejects the wrong object type", () => {
    expect(() => assertContactId("001000000000001AAA")).toThrow();
    expect(() => assertAccountId("003000000000001AAA")).toThrow();
  });
});

describe("Salesforce client", () => {
  it("signs a JWT bearer assertion with iss, sub, aud and a short expiry", () => {
    const jwt = buildJwtAssertion(config, 1_700_000_000_000);
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({ iss: "ck", sub: "svc@crc.test", aud: "https://login.example.test", exp: 1_700_000_180 });
    expect(createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s, "base64url"))).toBe(true);
  });

  it("signs in, queries with GET only, strips attributes and follows the cursor", async () => {
    const { fn, calls } = fakeFetch([
      tokenOk,
      () => Response.json({ done: false, nextRecordsUrl: "/services/data/v62.0/query/01gX-2000", records: [{ attributes: { type: "Contact" }, Id: "1", Account: { attributes: {}, Name: "H" } }] }),
      () => Response.json({ done: true, records: [{ attributes: {}, Id: "2" }] }),
    ]);
    const sf = createSalesforceClient(config, { fetch: fn });
    const rows = await sf.query("SELECT Id, Account.Name FROM Contact");
    expect(rows).toEqual([{ Id: "1", Account: { Name: "H" } }, { Id: "2" }]);
    expect(calls[0].url).toBe("https://login.example.test/services/oauth2/token");
    expect(String(calls[0].init.body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    expect(calls[1].url).toBe(`https://crc.my.example.test/services/data/v62.0/query?q=${encodeURIComponent("SELECT Id, Account.Name FROM Contact")}`);
    expect(calls[1].init.method).toBe("GET");
    expect(calls[2].url).toBe("https://crc.my.example.test/services/data/v62.0/query/01gX-2000");
    expect(calls.slice(1).every((c) => c.init.method === "GET")).toBe(true);
  });

  it("reuses the token and re-signs once on a 401", async () => {
    const { fn, calls } = fakeFetch([tokenOk, () => Response.json({ done: true, records: [] }), () => new Response("", { status: 401 }), tokenOk, () => Response.json({ done: true, records: [] })]);
    const sf = createSalesforceClient(config, { fetch: fn });
    await sf.query("SELECT Id FROM Contact");
    await sf.query("SELECT Id FROM Contact");
    expect(calls.map((c) => c.url.includes("oauth2") ? "token" : "query")).toEqual(["token", "query", "query", "token", "query"]);
  });

  it("refuses a write before any request is made", async () => {
    const { fn, calls } = fakeFetch([]);
    const sf = createSalesforceClient(config, { fetch: fn });
    await expect(sf.query("DELETE FROM Contact")).rejects.toBeInstanceOf(RefusedQuery);
    expect(calls).toHaveLength(0);
  });

  it("refuses an unexpected cursor URL", async () => {
    const { fn } = fakeFetch([tokenOk, () => Response.json({ done: false, nextRecordsUrl: "https://evil.example.test/x", records: [] })]);
    await expect(createSalesforceClient(config, { fetch: fn }).query("SELECT Id FROM Contact")).rejects.toBeInstanceOf(SalesforceError);
  });

  it("reports failures by status without the response body", async () => {
    const { fn } = fakeFetch([tokenOk, () => new Response("INVALID_FIELD: secret detail", { status: 400 })]);
    const err = await createSalesforceClient(config, { fetch: fn }).query("SELECT Id FROM Contact").catch((e) => e);
    expect(err).toBeInstanceOf(SalesforceError);
    expect(err.status).toBe(400);
    expect(err.message).not.toContain("secret detail");
  });

  it("exposes query and nothing else", () => {
    expect(Object.keys(createSalesforceClient(config))).toEqual(["query"]);
  });
});
