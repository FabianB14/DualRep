import { randomUUID } from 'expo-crypto';

/**
 * A new primary key for a row created on this device. Ids are made on the device (not by Postgres)
 * so rows can be created offline and referenced by other rows before they are ever uploaded.
 * expo-crypto's randomUUID is a native, synchronous UUIDv4 (Expo does not install a global crypto).
 */
export function newId(): string {
  return randomUUID();
}
