import { useEffect, useRef, useState } from "react";
import { Check, Copy, Crown, Loader2, LogOut, Radio, Send, Users } from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useTranslation } from "@/lib/i18n-hook";
import type { ChatMessage, PartyMember, WatchPartyRoom } from "@/lib/party/types";

interface WatchTogetherDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: WatchPartyRoom | null;
  members: PartyMember[];
  currentAccountId: number | null;
  isHost: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  isCreating?: boolean;
  error: string | null;
  chatMessages: ChatMessage[];
  onCreateParty: () => void;
  onJoinParty: (code: string) => void;
  onLeaveParty: () => void;
  onSendChat: (text: string) => void;
}

export function WatchTogetherDialog({
  open,
  onOpenChange,
  room,
  members,
  currentAccountId,
  isHost,
  isConnected,
  isConnecting,
  isCreating = false,
  error,
  chatMessages,
  onCreateParty,
  onJoinParty,
  onLeaveParty,
  onSendChat,
}: WatchTogetherDialogProps) {
  const { t } = useTranslation();
  const [inputCode, setInputCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [chatText, setChatText] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages.length]);

  const handleCopyLink = async () => {
    if (!room) return;
    const url = new URL(window.location.href);
    url.searchParams.set("party", room.code);
    await navigator.clipboard.writeText(url.toString());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyCode = async () => {
    if (!room) return;
    await navigator.clipboard.writeText(room.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleJoinSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputCode.trim()) return;
    onJoinParty(inputCode.trim().toUpperCase());
    setInputCode("");
  };

  const handleChatSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatText.trim()) return;
    onSendChat(chatText);
    setChatText("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-6">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Users className="size-5 text-primary" />
            <DialogTitle className="text-xl font-bold">{t("party_title")}</DialogTitle>
          </div>
          <DialogDescription className="text-sm text-muted-foreground">
            {room ? t("party_syncNotice") : t("auth_subtitle")}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <div className="rounded-lg bg-destructive/15 p-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {room ? (
          /* Active Party Room View */
          <div className="space-y-4">
            {/* Room Code & Invite Card */}
            <div className="flex items-center justify-between rounded-xl border border-border bg-card p-3">
              <div>
                <p className="text-xs text-muted-foreground">{t("party_roomCode")}</p>
                <p className="font-mono text-xl font-bold tracking-wider text-foreground">
                  {room.code}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCopyCode}
                  className="gap-1.5 text-xs"
                >
                  {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
                  {copied ? t("party_copied") : t("party_inviteLink")}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-muted-foreground hover:text-destructive"
                  onClick={onLeaveParty}
                  title={t("party_leave")}
                >
                  <LogOut className="size-4" />
                </Button>
              </div>
            </div>

            {/* Status indicator */}
            <div className="flex items-center gap-2 text-xs">
              <span className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex size-2 rounded-full bg-emerald-500"></span>
              </span>
              <span className="font-medium text-emerald-500">{t("party_connected")}</span>
              <span className="text-muted-foreground">•</span>
              <span className="text-muted-foreground">
                {isHost ? t("party_host") : "Guest"}
              </span>
            </div>

            {/* Participants list */}
            <div>
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("party_members")} ({members.length})
              </p>
              <div className="flex flex-wrap gap-2">
                {members.map((member) => {
                  const isYou = member.id === currentAccountId;
                  return (
                    <div
                      key={member.id}
                      className="flex items-center gap-2 rounded-full border border-border bg-card/60 py-1 pl-1 pr-3"
                    >
                      {member.profilePicture ? (
                        <Avatar className="size-6">
                          <img
                            src={member.profilePicture}
                            alt={member.name}
                            className="aspect-square h-full w-full rounded-full object-cover"
                          />
                        </Avatar>
                      ) : (
                        <Avatar className="size-6">
                          <AvatarFallback
                            style={{ backgroundColor: member.color || "#6366f1" }}
                            className="text-[10px] font-semibold text-white"
                          >
                            {member.name.slice(0, 1).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                      )}
                      <span className="max-w-[100px] truncate text-xs font-medium text-foreground">
                        {member.name}
                      </span>
                      {member.isHost ? (
                        <Badge
                          variant="secondary"
                          className="h-4 gap-0.5 px-1 text-[9px] font-semibold"
                        >
                          <Crown className="size-2.5 text-amber-500" />
                          Host
                        </Badge>
                      ) : null}
                      {isYou ? (
                        <span className="text-[10px] text-muted-foreground">({t("party_you")})</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Live Chat */}
            <div className="space-y-2 pt-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t("party_chat")}
              </p>
              <ScrollArea className="h-40 rounded-lg border border-border bg-muted/20 p-2.5">
                {chatMessages.length === 0 ? (
                  <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                    Nessun messaggio ancora. Saluta i tuoi amici!
                  </div>
                ) : (
                  <div className="space-y-2">
                    {chatMessages.map((msg) => {
                      const isMe = msg.sender.id === currentAccountId;
                      return (
                        <div key={msg.id} className="text-xs">
                          <div className="flex items-baseline gap-1.5">
                            <span
                              className="font-semibold"
                              style={{ color: msg.sender.color || "#6366f1" }}
                            >
                              {msg.sender.name}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {new Date(msg.timestamp).toLocaleTimeString([], {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                            </span>
                          </div>
                          <p className="mt-0.5 break-words text-foreground/90">{msg.text}</p>
                        </div>
                      );
                    })}
                    <div ref={messagesEndRef} />
                  </div>
                )}
              </ScrollArea>

              {/* Chat Input */}
              <form onSubmit={handleChatSubmit} className="flex gap-2">
                <Input
                  value={chatText}
                  onChange={(e) => setChatText(e.target.value)}
                  placeholder={isConnected ? t("party_typeMessage") : t("party_syncing")}
                  disabled={!isConnected}
                  className="h-9 text-xs"
                />
                <Button
                  type="submit"
                  size="sm"
                  className="h-9 px-3"
                  disabled={!chatText.trim() || !isConnected}
                >
                  <Send className="size-3.5" />
                </Button>
              </form>
            </div>
          </div>
        ) : (
          /* Join or Create Party View */
          <div className="space-y-6 pt-2">
            <div className="space-y-2">
              <Button
                onClick={onCreateParty}
                disabled={isCreating}
                className="w-full gap-2 font-medium"
                size="lg"
              >
                {isCreating ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Radio className="size-4" />
                )}
                {isCreating ? t("party_syncing") : t("party_start")}
              </Button>
            </div>

            <div className="relative flex items-center justify-center">
              <span className="w-full border-t border-border" />
              <span className="absolute bg-background px-2 text-xs uppercase text-muted-foreground">
                {t("auth_or")}
              </span>
            </div>

            <form onSubmit={handleJoinSubmit} className="space-y-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-foreground">
                  {t("party_enterCode")}
                </label>
                <div className="flex gap-2">
                  <Input
                    value={inputCode}
                    onChange={(e) => setInputCode(e.target.value.toUpperCase())}
                    placeholder="e.g. CINE-42"
                    className="font-mono uppercase tracking-wider"
                    maxLength={10}
                    disabled={isConnecting || isCreating}
                  />
                  <Button type="submit" disabled={!inputCode.trim() || isConnecting || isCreating}>
                    {isConnecting ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      t("party_join")
                    )}
                  </Button>
                </div>
              </div>
            </form>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

