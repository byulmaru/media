import type { Env as WorkerEnv } from "../src/types";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
    interface Exports {
      default: {
        fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
      };
    }
  }
}

export {};
