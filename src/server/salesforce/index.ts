import "server-only";
import { isDemo } from "@/lib/demo";
import { demoSalesforce } from "@/server/demo/salesforce";
import { createSalesforceClient, type SalesforceClient } from "./client";

let client: SalesforceClient | null = null;

/**
 * The shared client, configured from the same variables as MavenAI's service account
 * (SF_JWT_CONSUMER_KEY, SF_JWT_USERNAME, SF_JWT_PRIVATE_KEY, SF_JWT_AUDIENCE,
 * SF_SERVICE_INSTANCE_URL) so the credentials can be shared.
 */
export function getSalesforce(): SalesforceClient {
  if (client) return client;
  // The demo build reads an invented congregation and never reaches Salesforce, whatever is configured.
  if (isDemo()) return (client = demoSalesforce());
  const consumerKey = process.env.SF_JWT_CONSUMER_KEY;
  const username = process.env.SF_JWT_USERNAME;
  const privateKey = process.env.SF_JWT_PRIVATE_KEY;
  if (!consumerKey || !username || !privateKey) throw new Error("Salesforce is not configured (SF_JWT_CONSUMER_KEY, SF_JWT_USERNAME, SF_JWT_PRIVATE_KEY)");
  client = createSalesforceClient({
    consumerKey,
    username,
    privateKey,
    audience: process.env.SF_JWT_AUDIENCE || "https://login.salesforce.com",
    instanceUrl: process.env.SF_SERVICE_INSTANCE_URL || undefined,
  });
  return client;
}
