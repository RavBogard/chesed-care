import "server-only";
import { getDb } from "@/server/db/client";
import { authEnv } from "@/server/env";
import { createAuth, type Auth } from "./factory";

let auth: Auth | null = null;

/** The app's auth instance, built on first request (never at build time). */
export function getAuth(): Auth {
  auth ??= createAuth(getDb(), authEnv());
  return auth;
}
