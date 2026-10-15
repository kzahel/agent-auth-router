import type { Account } from "../protocol/types.ts";

/** The account's profile path, with its nickname when it has one. */
export const accountLabel = (a: Pick<Account, "id"> & Partial<Account>) => `${a.home ?? a.id}${a.nickname ? ` · ${a.nickname}` : ""}`;

/** A short name for tables: the nickname, else the profile folder's name. */
export const accountName = (a: Pick<Account, "id"> & Partial<Account>) =>
  a.nickname || (a.home ?? a.id).split("/").filter(Boolean).at(-1) || a.id;
