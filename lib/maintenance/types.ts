export type MaintenanceModeStatus = Readonly<{
  active: boolean;
  reason: string | null;
  activatedAt: string | null;
  activatedBy: string | null;
}>;

export type MaintenanceModeErrorCode =
  | "MAINTENANCE_MODE_ACTIVE"
  | "MAINTENANCE_STATE_UNAVAILABLE"
  | "NOT_PRODUCTION_ENVIRONMENT"
  | "INVALID_TRANSITION"
  | "PERSISTENCE_FAILURE";

export type MaintenanceModeError = Readonly<{
  code: MaintenanceModeErrorCode;
  message: string;
}>;

export type MaintenanceModeResult<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; error: MaintenanceModeError }>;

export type MaintenanceStateRecord = Readonly<{
  id: string;
  active: boolean;
  reason: string | null;
  activatedAt: Date | null;
  activatedBy: string | null;
  deactivatedAt: Date | null;
  deactivatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type MaintenanceRepository = Readonly<{
  getState: () => Promise<MaintenanceStateRecord | null>;
  activate: (
    reason: string,
    activatedBy: string,
  ) => Promise<MaintenanceStateRecord>;
  deactivate: (deactivatedBy: string) => Promise<MaintenanceStateRecord>;
  ensureInitialized: () => Promise<void>;
}>;

export type IsProductionEnvironment = () => boolean;