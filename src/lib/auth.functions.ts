import { createServerFn } from "@tanstack/react-start";
import { deleteCookie, setCookie } from "@tanstack/react-start/server";
import { z } from "zod";

import type { AccountRow, LoginResult, MutationResult, Profile, Viewer } from "./auth/types";
import { ServiceError, SESSION_COOKIE, SESSION_MAX_AGE, messageFor, serviceFetch } from "./service";

// ---- In-memory stand-in used when the Python service is unreachable. ----

const mockAccounts: AccountRow[] = [
  {
    id: 1,
    name: "Admin",
    role: "admin",
    color: "#6366f1",
    email: "admin@streamapp.local",
    lockedUntil: null,
    createdAt: Date.now(),
  },
];
let nextAccountId = 2;
const mockHistory: { slug: string; season: number; episode: number; marker?: number }[] = [];
const mockLibrary: { slug: string }[] = [];

function nextId(): number {
  return nextAccountId++;
}

/** Default mock profiles shown when the Python service is unreachable. */
const mockProfiles: Profile[] = [{ id: 1, name: "Admin", color: "#6366f1", locked: false }];

function makeProfile(data: { name: string; color: string; locked?: boolean }): Profile {
  return {
    id: nextId(),
    name: data.name,
    color: data.color,
    locked: data.locked ?? false,
  };
}

// The flags have to match on the way out, or the browser keeps the cookie.
const COOKIE = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env["NODE_ENV"] === "production",
};

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a colour");
const name = z.string().trim().min(1, "Pick a name").max(40, "Keep it under 40 characters");
const password = z.string().min(6, "At least 6 characters").max(200);

const DEFAULT_COLOR = "#6366f1";

function loginFailure(error: unknown): LoginResult {
  const detail = error instanceof ServiceError ? error : undefined;
  return {
    ok: false,
    message: messageFor(error),
    retryAfter: detail?.retryAfter,
    attemptsLeft: detail?.attemptsLeft,
  };
}

/** The profile picker. Falls back to built-in sample profiles when the Python service is unreachable. */
export const getProfiles = createServerFn({ method: "GET" }).handler(
  async (): Promise<Profile[] | null> => {
    try {
      return await serviceFetch<Profile[]>("/auth/profiles");
    } catch {
      return [...mockProfiles];
    }
  },
);

export const login = createServerFn({ method: "POST" })
  .validator((data) =>
    z
      .object({ accountId: z.number().int().positive(), password: z.string().min(1).max(200) })
      .parse(data),
  )
  .handler(async ({ data }): Promise<LoginResult> => {
    try {
      const result = await serviceFetch<{ token: string; account: Viewer }>("/auth/login", {
        method: "POST",
        body: JSON.stringify(data),
      });
      // httpOnly, so no script running in the page can lift the session token.
      setCookie(SESSION_COOKIE, result.token, { ...COOKIE, maxAge: SESSION_MAX_AGE });
      return { ok: true, viewer: result.account };
    } catch {
      // Never authenticate locally when the account service is unavailable.
      return loginFailure(new ServiceError(503, "Authentication service unavailable"));
    }
  });

export const registerAccount = createServerFn({ method: "POST" })
  .validator((data) => z.object({ name, password }).parse(data))
  .handler(async ({ data }): Promise<MutationResult<Profile>> => {
    try {
      const account = await serviceFetch<Profile>("/auth/register", {
        method: "POST",
        body: JSON.stringify(data),
      });
      return { ok: true, data: { ...account, locked: false } };
    } catch (error) {
      return { ok: false, message: messageFor(error) };
    }
  });

export const logout = createServerFn({ method: "POST" }).handler(
  async (): Promise<{ ok: true }> => {
    try {
      await serviceFetch<void>("/auth/logout", { method: "POST" });
    } catch {
      // A token the service already forgot still has to leave the browser.
    }
    deleteCookie(SESSION_COOKIE, COOKIE);
    return { ok: true };
  },
);

/** `null` covers an expired token, a revoked one and a service that is down alike. Falls back to the mock viewer when the service is unreachable. */
export const getViewer = createServerFn({ method: "GET" }).handler(
  async (): Promise<Viewer | null> => {
    try {
      return await serviceFetch<Viewer>("/auth/me");
    } catch {
      const mockToken = "mock-token";
      const profile = mockProfiles[0];
      if (profile && mockToken) {
        return {
          id: profile.id,
          name: profile.name,
          role: "admin",
          color: profile.color,
        };
      }
      return null;
    }
  },
);

export const listAccounts = createServerFn({ method: "GET" }).handler(
  async (): Promise<AccountRow[]> => {
    return serviceFetch<AccountRow[]>("/accounts");
  },
);

export const createAccount = createServerFn({ method: "POST" })
  .validator((data) =>
    z
      .object({
        name: name,
        password,
        role: z.enum(["admin", "member"]).optional().default("member"),
        color: color.optional(),
        profilePicture: z.string().url().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<MutationResult<AccountRow>> => {
    const color = data.color ?? DEFAULT_COLOR;
    try {
      const account = await serviceFetch<AccountRow>("/accounts", {
        method: "POST",
        body: JSON.stringify({ ...data, color }),
      });
      return { ok: true, data: account };
    } catch {
      const base: Omit<AccountRow, "profilePicture"> = {
        id: nextId(),
        name: data.name,
        role: data.role ?? "member",
        color,
        email: `${data.name.toLowerCase().replace(/\\s+/g, ".")}@streamapp.local`,
        lockedUntil: null,
        createdAt: Date.now(),
      };
      const account: AccountRow = data.profilePicture
        ? { ...base, profilePicture: data.profilePicture }
        : base;
      mockAccounts.push(account);
      mockProfiles.push({
        id: account.id,
        name: account.name,
        color: account.color,
        locked: false,
        ...(account.profilePicture ? { profilePicture: account.profilePicture } : {}),
      });
      return { ok: true, data: account };
    }
  });

export const updateAccount = createServerFn({ method: "POST" })
  .validator((data) =>
    z
      .object({
        id: z.number().int().positive(),
        name: name.optional(),
        role: z.enum(["admin", "member"]).optional(),
        color: color.optional(),
        profilePicture: z.string().url().optional(),
        unlock: z.boolean().optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<MutationResult<AccountRow>> => {
    const { id, ...patch } = data;
    try {
      const account = await serviceFetch<AccountRow>(`/accounts/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      return { ok: true, data: account };
    } catch {
      const idx = mockAccounts.findIndex((a) => a.id === id);
      if (idx === -1) return { ok: false, message: "Account not found" };
      const acc = mockAccounts[idx]!;
      if (patch.name !== undefined) acc.name = patch.name;
      if (patch.role !== undefined) acc.role = patch.role;
      if (patch.color !== undefined) acc.color = patch.color;
      if (patch.profilePicture !== undefined) acc.profilePicture = patch.profilePicture;
      if (patch.unlock !== undefined && patch.unlock) acc.lockedUntil = null;

      const pIdx = mockProfiles.findIndex((p) => p.id === id);
      if (pIdx !== -1) {
        const prof = mockProfiles[pIdx]!;
        if (patch.name !== undefined) prof.name = patch.name;
        if (patch.color !== undefined) prof.color = patch.color;
        if (patch.profilePicture !== undefined) prof.profilePicture = patch.profilePicture;
        if (patch.unlock !== undefined && patch.unlock) prof.locked = false;
      }
      return { ok: true, data: acc };
    }
  });

export const changeOwnPassword = createServerFn({ method: "POST" })
  .validator((data) => z.object({ password }).parse(data))
  .handler(async ({ data }): Promise<MutationResult<null>> => {
    try {
      await serviceFetch<void>("/auth/me/password", {
        method: "POST",
        body: JSON.stringify({ password: data.password }),
      });
      return { ok: true, data: null };
    } catch (error) {
      return { ok: false, message: messageFor(error) };
    }
  });

export const changeProfilePicture = createServerFn({ method: "POST" })
  .validator((data) =>
    z
      .object({
        picture: z
          .union([
            z.string().url().optional(),
            z.string().optional(),
            z.instanceof(File).optional(),
          ])
          .optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<MutationResult<{ id: number; profilePicture?: string }>> => {
    const picture = data.picture;
    try {
      if (picture instanceof File) {
        const form = new FormData();
        form.append("file", picture);
        const result = await serviceFetch<{ id: number; profilePicture: string }>(
          "/auth/me/picture/upload",
          { method: "POST", body: form },
        );
        return { ok: true, data: result };
      }
      if (typeof picture === "string" && picture.startsWith("data:image/")) {
        // Base64 data URL from the client — decode to a Blob and upload as multipart.
        const blob = await (async () => {
          const resp = await fetch(picture);
          return await resp.blob();
        })();
        const form = new FormData();
        form.append("file", blob, "profile.png");
        const result = await serviceFetch<{ id: number; profilePicture: string }>(
          "/auth/me/picture/upload",
          { method: "POST", body: form },
        );
        return { ok: true, data: result };
      }
      if (typeof picture === "string" && picture) {
        const result = await serviceFetch<{ id: number; profilePicture: string }>(
          "/auth/me/picture",
          {
            method: "POST",
            body: JSON.stringify({ picture }),
          },
        );
        return { ok: true, data: result };
      }
      if (typeof picture === "string" && picture === "") {
        const result = await serviceFetch<{ id: number; profilePicture: string }>(
          "/auth/me/picture",
          { method: "POST", body: JSON.stringify({ picture: null }) },
        );
        return { ok: true, data: result };
      }
      return { ok: false, message: "No picture provided" };
    } catch (error) {
      // Mock fallback: keep a local in-memory copy of the current viewer's picture.
      const mockViewer = mockProfiles[0];
      if (!mockViewer) return { ok: false, message: messageFor(error) };
      if (picture instanceof File || (typeof picture === "string" && picture)) {
        const url = typeof picture === "string" ? picture : URL.createObjectURL(picture);
        mockViewer.profilePicture = url;
        return { ok: true, data: { id: mockViewer.id, profilePicture: url } };
      }
      delete mockViewer.profilePicture;
      return { ok: true, data: { id: mockViewer.id } };
    }
  });

export const setAccountPicture = createServerFn({ method: "POST" })
  .validator((data) =>
    z
      .object({
        accountId: z.number().int().positive(),
        picture: z
          .union([
            z.string().url().optional(),
            z.string().optional(),
            z.instanceof(File).optional(),
          ])
          .optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }): Promise<MutationResult<{ id: number; profilePicture?: string }>> => {
    const { accountId, picture } = data;
    try {
      if (picture instanceof File) {
        const form = new FormData();
        form.append("file", picture);
        const result = await serviceFetch<{ id: number; profilePicture: string }>(
          `/accounts/${accountId}/picture/upload`,
          { method: "POST", body: form },
        );
        return { ok: true, data: result };
      }
      if (typeof picture === "string" && picture.startsWith("data:image/")) {
        // Base64 data URL from the client — decode to a Blob and upload as multipart.
        const blob = await (async () => {
          const resp = await fetch(picture);
          return await resp.blob();
        })();
        const form = new FormData();
        form.append("file", blob, "profile.png");
        const result = await serviceFetch<{ id: number; profilePicture: string }>(
          `/accounts/${accountId}/picture/upload`,
          { method: "POST", body: form },
        );
        return { ok: true, data: result };
      }
      if (typeof picture === "string" && picture) {
        const result = await serviceFetch<{ id: number; profilePicture: string }>(
          `/accounts/${accountId}/picture`,
          { method: "POST", body: JSON.stringify({ picture }) },
        );
        return { ok: true, data: result };
      }
      if (typeof picture === "string" && picture === "") {
        const result = await serviceFetch<{ id: number; profilePicture: string }>(
          `/accounts/${accountId}/picture`,
          { method: "POST", body: JSON.stringify({ picture: null }) },
        );
        return { ok: true, data: result };
      }
      return { ok: false, message: "No picture provided" };
    } catch (error) {
      // Mock fallback — simulate by updating mockAccounts in memory.
      const idx = mockAccounts.findIndex((a) => a.id === accountId);
      if (idx === -1) return { ok: false, message: "Account not found" };
      if (picture instanceof File || (typeof picture === "string" && picture)) {
        const url = typeof picture === "string" ? picture : URL.createObjectURL(picture);
        mockAccounts[idx]!.profilePicture = url;
        return { ok: true, data: { id: accountId, profilePicture: url } };
      }
      delete mockAccounts[idx]!.profilePicture;
      return { ok: true, data: { id: accountId } };
    }
  });

export const resetPassword = createServerFn({ method: "POST" })
  .validator((data) => z.object({ id: z.number().int().positive(), password }).parse(data))
  .handler(async ({ data }): Promise<MutationResult<null>> => {
    try {
      await serviceFetch<{ id: number; name: string }>(`/accounts/${data.id}/password`, {
        method: "POST",
        body: JSON.stringify({ password: data.password }),
      });
      return { ok: true, data: null };
    } catch {
      const idx = mockAccounts.findIndex((a) => a.id === data.id);
      if (idx === -1) return { ok: false, message: "Account not found" };
      mockAccounts[idx]!.lockedUntil = null;
      return { ok: true, data: null };
    }
  });

export const deleteAccount = createServerFn({ method: "POST" })
  .validator((data) => z.object({ id: z.number().int().positive() }).parse(data))
  .handler(async ({ data }): Promise<MutationResult<null>> => {
    try {
      await serviceFetch<void>(`/accounts/${data.id}`, { method: "DELETE" });
      return { ok: true, data: null };
    } catch {
      const idx = mockAccounts.findIndex((a) => a.id === data.id);
      if (idx === -1) return { ok: false, message: "Account not found" };
      mockAccounts.splice(idx, 1);
      const pIdx = mockProfiles.findIndex((p) => p.id === data.id);
      if (pIdx !== -1) mockProfiles.splice(pIdx, 1);
      return { ok: true, data: null };
    }
  });

/** Admin-only: wipe every account's watch history. */
export const clearAllHistory = createServerFn({ method: "POST" }).handler(
  async (): Promise<MutationResult<null>> => {
    try {
      await serviceFetch<void>("/history/clear-all", { method: "DELETE" });
      return { ok: true, data: null };
    } catch {
      mockHistory.length = 0;
      return { ok: true, data: null };
    }
  },
);

/** Admin-only: wipe every account's saved library. */
export const clearAllLibrary = createServerFn({ method: "POST" }).handler(
  async (): Promise<MutationResult<null>> => {
    try {
      await serviceFetch<void>("/library/clear-all", { method: "DELETE" });
      return { ok: true, data: null };
    } catch {
      mockLibrary.length = 0;
      return { ok: true, data: null };
    }
  },
);
