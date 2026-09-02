import type { SecretStore } from "../../src/secrets.ts";

export function memorySecretStore(): SecretStore {
  const values = new Map<string, string>();
  return {
    get: async (name) => values.get(name),
    set: async (name, value) => {
      values.set(name, value);
    },
    delete: async (name) => {
      values.delete(name);
    },
  };
}
