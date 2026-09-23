import { createServerFn } from "@tanstack/react-start";
import { getCookie } from "@tanstack/react-start/server";
import { z } from "zod";

import type { PartyMedia, WatchPartyRoom } from "./types";
import { SESSION_COOKIE, serviceFetch } from "../service";

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
});

export const getPartyToken = createServerFn({ method: "GET" }).handler(async () => {
  const token = getCookie(SESSION_COOKIE);
  return token || null;
});

export const createPartyRoom = createServerFn({ method: "POST" })
  .validator((data: { media: PartyMedia; initialTime?: number }) => createPartySchema.parse(data))
  .handler(async ({ data }) => {
    const result = await serviceFetch<WatchPartyRoom>("/party/create", {
      method: "POST",
      body: JSON.stringify(data),
    });
    return result;
  });

export const getPartyRoom = createServerFn({ method: "GET" })
  .validator((data: { code: string }) =>
    z.object({ code: z.string().min(1) }).parse(data),
  )
  .handler(async ({ data }) => {
    const result = await serviceFetch<WatchPartyRoom>(`/party/${encodeURIComponent(data.code)}`, {
      method: "GET",
    });
    return result;
  });

