import { createFactoryClient } from "@labq/client";

export const client = createFactoryClient({
  baseUrl: typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:3000",
});
