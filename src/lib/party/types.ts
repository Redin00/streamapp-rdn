export interface PartyMedia {
  slug: string;
  tmdbId?: number | null | undefined;
  type: "movie" | "tv";
  season?: number | null | undefined;
  episode?: number | null | undefined;
  titleName?: string | undefined;
}

export interface PartyMember {
  id: number;
  name: string;
  color: string;
  profilePicture?: string | null | undefined;
  isHost: boolean;
}

export interface PartyPlaybackState {
  time: number;
  isPlaying: boolean;
  lastUpdated: number;
}

export interface ChatMessage {
  id: string;
  text: string;
  sender: {
    id: number;
    name: string;
    color: string;
    profilePicture?: string | null | undefined;
  };
  timestamp: number;
}

export interface WatchPartyRoom {
  code: string;
  hostId: number;
  media: PartyMedia;
  state: PartyPlaybackState;
  members: PartyMember[];
  chatHistory?: ChatMessage[] | undefined;
  createdAt: number;
}

export type PartyEvent =
  | { type: "ROOM_STATE"; data: WatchPartyRoom; yourAccountId: number }
  | { type: "MEMBER_JOINED"; member: PartyMember; members: PartyMember[] }
  | { type: "MEMBER_LEFT"; memberId: number; members: PartyMember[] }
  | { type: "HOST_CHANGED"; newHostId: number; members: PartyMember[] }
  | { type: "PLAY"; time: number; senderId: number; senderName: string }
  | { type: "PAUSE"; time: number; senderId: number; senderName: string }
  | { type: "SEEK"; time: number; senderId: number; senderName: string }
  | { type: "SYNC_TICK"; time: number; isPlaying: boolean; timestamp: number }
  | { type: "CHANGE_MEDIA"; media: PartyMedia; time: number; senderId: number; senderName: string }
  | {
      type: "CHAT";
      id?: string;
      text: string;
      sender: {
        id: number;
        name: string;
        color: string;
        profilePicture?: string | null | undefined;
      };
      timestamp: number;
    }
  | { type: "ERROR"; message: string };
