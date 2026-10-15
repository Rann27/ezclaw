import { DEFAULT_SETTINGS, settingsSchema, type Settings, type SettingsPatch } from "@ezclaw/core";
import type { Db } from "./db/client.js";
import { settings } from "./db/schema.js";

type SettingKey = keyof Settings;

export function getSettings(db: Db): Settings {
  const result: Settings = { ...DEFAULT_SETTINGS };
  for (const row of db.select().from(settings).all()) {
    const key = row.key as SettingKey;
    const fieldSchema = settingsSchema.shape[key];
    if (!fieldSchema) continue;
    // A stored value that no longer matches its schema falls back to the default.
    const parsed = fieldSchema.safeParse(row.value);
    if (parsed.success) (result as Record<string, unknown>)[key] = parsed.data;
  }
  return result;
}

export function updateSettings(db: Db, patch: SettingsPatch): Settings {
  const now = new Date();
  db.transaction((tx) => {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      tx.insert(settings)
        .values({ key, value, updatedAt: now })
        .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } })
        .run();
    }
  });
  return getSettings(db);
}
