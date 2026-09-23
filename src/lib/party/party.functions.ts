import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { z } from "zod";

import type { PartyEventResponse, PartyMedia, PartyPollResponse, WatchPartyRoom } from "./types";
import { SESSION_COOKIE, messageFor, serviceFetch } from "../service";

const mediaSchema = z.object({
  slug: z.string().min(1),
  tmdbId: z.number().nullable().optional(),
  type: z.enum(["movie", "tv"]),
  season: z.number().nullable().optional(),
  episode: z.number().nullable().optional(),
  titleName: z.string().optional(),
});

const createPartySchema = z.object({
  media: mediaSchema,
  initialTime: z.number().default(0),
  guestId: z.string().optional(),
  guestName: z.string().optional(),
  guestColor: z.string().optional(),
  guestAvatar: z.string().nullable().optional(),
});

export const getPartyConnectionInfo = createServerFn({ method: "GET" }).handler(async () => {
  const token = getCookie(SESSION_COOKIE) || null;
  const scBaseUrl = process.env["SC_BASE_URL"] || null;
  const scPort = process.env["SC_PORT"] || "8000";
  return { token, scBaseUrl, scPort };
});

export const getPartyToken = createServerFn({ method: "GET" }).handler(async () => {
  const token = getCookie(SESSION_COOKIE);
  return token || null;
});

export const createPartyRoom = createServerFn({ method: "POST" })
  .validator((data: {
    media: PartyMedia;
    initialTime?: number | undefined;
    guestId?: string | undefined;
    guestName?: string | undefined;
    guestColor?: string | undefined;
    guestAvatar?: string | null | undefined;
  }) => createPartySchema.parse(data))
  .handler(async ({ data }): Promise<{ ok: boolean; room?: WatchPartyRoom; message?: string }> => {
    try {
      const result = await serviceFetch<WatchPartyRoom>("/party/create", {
        method: "POST",
        body: JSON.stringify(data),
      });
      return { ok: true, room: result };
    } catch (err) {
      console.error("Failed to create watch party room:", err);
      return { ok: false, message: messageFor(err) };
    }
  });

export const getPartyRoom = createServerFn({ method: "GET" })
  .validator((data: { code: string }) =>
    z.object({ code: z.string().min(1) }).parse(data),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; room?: WatchPartyRoom; message?: string }> => {
    try {
      const result = await serviceFetch<WatchPartyRoom>(`/party/${encodeURIComponent(data.code)}`, {
        method: "GET",
      });
      return { ok: true, room: result };
    } catch (err) {
      return { ok: false, message: messageFor(err) };
    }
  });

export const sendPartyEvent = createServerFn({ method: "POST" })
  .validator((data: {
    code: string;
    event: Record<string, unknown>;
    guestId?: string | undefined;
    guestName?: string | undefined;
    guestColor?: string | undefined;
    guestAvatar?: string | null | undefined;
  }) =>
    z.object({
      code: z.string().min(1),
      event: z.record(z.unknown()),
      guestId: z.string().optional(),
      guestName: z.string().optional(),
      guestColor: z.string().optional(),
      guestAvatar: z.string().nullable().optional(),
    }).parse(data),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; room?: WatchPartyRoom; message?: string }> => {
    try {
      const query = new URLSearchParams();
      if (data.guestId) query.set("guest_id", data.guestId);
      if (data.guestName) query.set("guest_name", data.guestName);
      if (data.guestColor) query.set("guest_color", data.guestColor);
      if (data.guestAvatar) query.set("guest_avatar", data.guestAvatar);
      const qs = query.toString() ? `?${query.toString()}` : "";

      const result = await serviceFetch<PartyEventResponse>(
        `/party/${encodeURIComponent(data.code)}/event${qs}`,
        {
          method: "POST",
          body: JSON.stringify(data.event),
        },
      );
      return { ok: true, room: result.room };
    } catch (err) {
      return { ok: false, message: messageFor(err) };
    }
  });

export const pollPartyRoom = createServerFn({ method: "GET" })
  .validator((data: {
    code: string;
    since?: number | undefined;
    guestId?: string | undefined;
    guestName?: string | undefined;
    guestColor?: string | undefined;
    guestAvatar?: string | null | undefined;
  }) =>
    z.object({
      code: z.string().min(1),
      since: z.number().default(0),
      guestId: z.string().optional(),
      guestName: z.string().optional(),
      guestColor: z.string().optional(),
      guestAvatar: z.string().nullable().optional(),
    }).parse(data),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; data?: PartyPollResponse; message?: string }> => {
    try {
      const query = new URLSearchParams();
      query.set("since", String(data.since || 0));
      if (data.guestId) query.set("guest_id", data.guestId);
      if (data.guestName) query.set("guest_name", data.guestName);
      if (data.guestColor) query.set("guest_color", data.guestColor);
      if (data.guestAvatar) query.set("guest_avatar", data.guestAvatar);

      const result = await serviceFetch<PartyPollResponse>(
        `/party/${encodeURIComponent(data.code)}/poll?${query.toString()}`,
        { method: "GET" },
      );
      return { ok: true, data: result };
    } catch (err) {
      return { ok: false, message: messageFor(err) };
    }
  });

export const leavePartyRoom = createServerFn({ method: "POST" })
  .validator((data: { code: string; guestId?: string | undefined }) =>
    z.object({ code: z.string().min(1), guestId: z.string().optional() }).parse(data),
  )
  .handler(async ({ data }): Promise<{ ok: boolean; message?: string }> => {
    try {
      const qs = data.guestId ? `?guest_id=${encodeURIComponent(data.guestId)}` : "";
      await serviceFetch<{ ok: boolean }>(`/party/${encodeURIComponent(data.code)}/leave${qs}`, {
        method: "POST",
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, message: messageFor(err) };
    }
  });

