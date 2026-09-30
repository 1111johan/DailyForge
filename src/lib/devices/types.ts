export interface OperatorDevice {
  recordId: string;
  id: string;
  name: string;
  enabled: boolean;
  worker: boolean;
  paired: boolean;
  lastSeenAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface AuthenticatedDevice extends OperatorDevice {
  tokenHash: string;
}
