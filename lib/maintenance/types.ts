export type MaintenanceStatus = Readonly<{
  active: boolean;
  reason: string | null;
  activatedAt: string | null;
  activatedBy: string | null;
}>;

export type MaintenanceErrorCode =
  | "MAINTENANCE_MODE_ACTIVE"
  | "MAINTENANCE_STATE_UNAVAILABLE"
  | "NOT_PRODUCTION_ENVIRONMENT"
  | "INVALID_INPUT"
  | "INVALID_TRANSITION"
  | "PERSISTENCE_FAILURE";

export type MaintenanceResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{
      ok: false;
      error: Readonly<{ code: MaintenanceErrorCode; message: string }>;
    }>;

export type MaintenanceRecord = Readonly<{
  id: string;
  active: boolean;
  reason: string;
  activatedAt: Date;
  activatedBy: string;
  deactivatedAt: Date | null;
  deactivatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type MaintenanceRepository = Readonly<{
  getActive: () => Promise<MaintenanceRecord | null>;
  activate: (input: Readonly<{
    reason: string;
    operator: string;
    at: Date;
  }>) => Promise<MaintenanceRecord>;
  deactivate: (input: Readonly<{
    operator: string;
    at: Date;
  }>) => Promise<MaintenanceRecord | null>;
}>;
