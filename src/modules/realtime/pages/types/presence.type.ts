export interface CursorPosition {
  row: number;
  column: number;
  selection?: {
    anchor: { row: number; column: number };
    head: { row: number; column: number };
  } | null;
}

export interface UserPresence {
  userId: string;
  socketId: string;
  projectId: string;
  name?: string | null;
  color?: string | null;
  avatar?: string | null;
  activeDocId?: string | null;
  cursor?: CursorPosition | null;
  lastHeartbeat: number;
}

export interface ClientSocketData {
  userId: string;
  name: string;
  color?: string;
  avatar?: string;
  projectId?: string | null;
  activeDocId?: string | null;
  authenticated: boolean;
}

export interface ChatMessage {
  id: string;
  projectId: string;
  userId: string;
  userName: string;
  userColor?: string;
  userAvatar?: string;
  text: string;
  replyToId?: string;
  createdAt: string;
}
