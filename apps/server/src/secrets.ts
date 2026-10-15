import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Entry } from "@napi-rs/keyring";

export interface SecretStoreStatus {
  backend: "keyring" | "file" | "memory";
  secure: boolean;
  detail: string;
}

/** Holds API keys. Keys never go into the SQLite database. */
export interface SecretStore {
  get(id: string): string | null;
  set(id: string, value: string): void;
  delete(id: string): void;
  status(): SecretStoreStatus;
}

const SERVICE = "ezclaw";

/** Windows Credential Manager (macOS Keychain, Linux Secret Service) through the OS. */
export class KeyringStore implements SecretStore {
  private entry(id: string) {
    return new Entry(SERVICE, id);
  }
  get(id: string): string | null {
    return this.entry(id).getPassword();
  }
  set(id: string, value: string): void {
    this.entry(id).setPassword(value);
  }
  delete(id: string): void {
    try {
      this.entry(id).deleteCredential();
    } catch {
      // Already gone.
    }
  }
  status(): SecretStoreStatus {
    return { backend: "keyring", secure: true, detail: "Penyimpanan kredensial OS (Windows Credential Manager atau setara)." };
  }
}

interface SealedValue {
  iv: string;
  tag: string;
  data: string;
}

/**
 * Fallback when no OS keyring works. The key sits next to the data, so this only protects
 * against casual reading of the file, not against someone with access to the folder.
 */
export class FileStore implements SecretStore {
  private readonly keyFile: string;
  private readonly dataFile: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.keyFile = join(dir, "secret.key");
    this.dataFile = join(dir, "secrets.json");
  }

  private key(): Buffer {
    if (existsSync(this.keyFile)) return Buffer.from(readFileSync(this.keyFile, "utf8"), "base64");
    const key = randomBytes(32);
    writeFileSync(this.keyFile, key.toString("base64"), { mode: 0o600 });
    return key;
  }

  private read(): Record<string, SealedValue> {
    if (!existsSync(this.dataFile)) return {};
    return JSON.parse(readFileSync(this.dataFile, "utf8")) as Record<string, SealedValue>;
  }

  private write(all: Record<string, SealedValue>) {
    const tmp = `${this.dataFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    renameSync(tmp, this.dataFile);
  }

  get(id: string): string | null {
    const sealed = this.read()[id];
    if (!sealed) return null;
    const decipher = createDecipheriv("aes-256-gcm", this.key(), Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
  }

  set(id: string, value: string): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const all = this.read();
    all[id] = { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
    this.write(all);
  }

  delete(id: string): void {
    const all = this.read();
    delete all[id];
    this.write(all);
  }

  status(): SecretStoreStatus {
    return {
      backend: "file",
      secure: false,
      detail: `Penyimpanan OS tidak tersedia. Key disimpan terenkripsi di ${dirname(this.dataFile)}, tapi kunci enkripsinya berada di folder yang sama.`,
    };
  }
}

export class MemoryStore implements SecretStore {
  private readonly map = new Map<string, string>();
  get(id: string) {
    return this.map.get(id) ?? null;
  }
  set(id: string, value: string) {
    this.map.set(id, value);
  }
  delete(id: string) {
    this.map.delete(id);
  }
  status(): SecretStoreStatus {
    return { backend: "memory", secure: false, detail: "Hanya di memori (untuk test)." };
  }
}

/** Picks the OS keyring when a write/read/delete round trip works, otherwise the encrypted file. */
export function createSecretStore(dataDir: string, mode: "auto" | "file" = "auto", log: (msg: string) => void = console.warn): SecretStore {
  if (mode === "file") return new FileStore(dataDir);
  const probeId = `probe:${randomBytes(6).toString("hex")}`;
  try {
    const store = new KeyringStore();
    store.set(probeId, "ok");
    const ok = store.get(probeId) === "ok";
    store.delete(probeId);
    if (ok) return store;
    log("[secrets] Keyring tidak mengembalikan nilai yang ditulis, memakai file terenkripsi.");
  } catch (err) {
    log(`[secrets] Keyring OS tidak bisa dipakai (${err instanceof Error ? err.message : String(err)}), memakai file terenkripsi.`);
  }
  return new FileStore(dataDir);
}
